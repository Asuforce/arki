use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use worker::*;

use crate::util::{image_extension, image_key, is_animated, sniff_image, ImageKind};
use crate::{epoch_to_iso, is_admin, json_error};

const MAX_BYTES: usize = 10 * 1024 * 1024;
/// Cloudflare Images が AVIF を出力できる辺の上限。超えると WebP か JPEG に落とされる。
const MAX_EDGE: u32 = 1200;
const AVIF_QUALITY: u32 = 70;
const KEY_HASH_LEN: usize = 16;

#[wasm_bindgen]
extern "C" {
    /// Cloudflare の Images バインディング（`env.IMAGES`）。workers-rs にラッパーが無い。
    type Images;

    #[wasm_bindgen(method, catch)]
    fn input(this: &Images, stream: &web_sys::ReadableStream) -> Result<ImageTransformer, JsValue>;

    type ImageTransformer;

    #[wasm_bindgen(method, catch)]
    fn transform(this: &ImageTransformer, options: &JsValue) -> Result<ImageTransformer, JsValue>;

    #[wasm_bindgen(method, catch)]
    fn output(this: &ImageTransformer, options: &JsValue) -> Result<js_sys::Promise, JsValue>;

    type ImageResult;

    #[wasm_bindgen(method)]
    fn response(this: &ImageResult) -> web_sys::Response;
}

/// 画像そのものが読めない・対応しない失敗か。それ以外（無料枠、課金、タイムアウト）はサービス側の失敗。
/// コードは https://developers.cloudflare.com/images/reference/troubleshooting/ による。
fn is_unreadable_image(error: &JsValue) -> bool {
    let text = format!("{error:?}");
    ["9402", "9413", "9520", "9523"]
        .iter()
        .any(|code| text.contains(code))
}

enum Converted {
    Image(Vec<u8>, String),
    Unreadable,
    ServiceFailed,
}

fn to_stream(bytes: &[u8]) -> std::result::Result<web_sys::ReadableStream, JsValue> {
    let array = js_sys::Uint8Array::from(bytes);
    let response = web_sys::Response::new_with_opt_buffer_source(Some(&array))?;
    response
        .body()
        .ok_or_else(|| JsValue::from_str("empty body"))
}

fn js_object(entries: &[(&str, JsValue)]) -> JsValue {
    let object = js_sys::Object::new();
    for (key, value) in entries {
        let _ = js_sys::Reflect::set(&object, &JsValue::from_str(key), value);
    }
    object.into()
}

/// 長辺を `MAX_EDGE` 以下に縮めて AVIF にする。拡大はしない。
/// 出力の形式は Images が決める（大きすぎると WebP か JPEG になる）。
async fn to_avif(images: &Images, bytes: &[u8]) -> Result<Converted> {
    let converted = async {
        let transformer = images.input(&to_stream(bytes)?)?.transform(&js_object(&[
            ("width", MAX_EDGE.into()),
            ("height", MAX_EDGE.into()),
            ("fit", "scale-down".into()),
        ]))?;
        let options = js_object(&[
            ("format", "image/avif".into()),
            ("quality", AVIF_QUALITY.into()),
        ]);
        JsFuture::from(transformer.output(&options)?).await
    }
    .await;
    let result = match converted {
        Ok(result) => result,
        Err(error) => {
            console_error!("image conversion failed: {error:?}");
            return Ok(if is_unreadable_image(&error) {
                Converted::Unreadable
            } else {
                Converted::ServiceFailed
            });
        }
    };
    let mut response: Response = result.unchecked_into::<ImageResult>().response().into();
    let content_type = response.headers().get("Content-Type")?.unwrap_or_default();
    Ok(Converted::Image(response.bytes().await?, content_type))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `POST /api/images`。本文は画像のバイト列そのもの。
/// 長辺 1200px の AVIF にして R2 に置く。アニメーションを持つ画像は変換せずそのまま置く。
pub async fn upload_image(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let declared = req
        .headers()
        .get("Content-Length")?
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > MAX_BYTES) {
        return json_error("image must be 10MB or smaller", 413);
    }
    let bytes = req.bytes().await?;
    if bytes.is_empty() {
        return json_error("body must be an image", 400);
    }
    if bytes.len() > MAX_BYTES {
        return json_error("image must be 10MB or smaller", 413);
    }
    let Some(kind) = sniff_image(&bytes) else {
        return json_error("only png, jpeg, gif and webp are accepted", 415);
    };

    let (stored, content_type) = if is_animated(&bytes, kind) {
        let content_type = match kind {
            ImageKind::Gif => "image/gif",
            ImageKind::Png => "image/png",
            ImageKind::Webp => "image/webp",
            ImageKind::Jpeg => "image/jpeg",
        };
        (bytes, content_type.to_string())
    } else {
        let binding = js_sys::Reflect::get(&ctx.env, &JsValue::from_str("IMAGES"))
            .ok()
            .filter(|b| !b.is_undefined() && !b.is_null());
        let Some(binding) = binding else {
            console_error!("IMAGES binding is not configured");
            return json_error("image conversion is not configured", 500);
        };
        match to_avif(&binding.unchecked_into(), &bytes).await? {
            Converted::Image(converted, content_type) => (converted, content_type),
            Converted::Unreadable => return json_error("could not read the image", 422),
            Converted::ServiceFailed => return json_error("image conversion failed", 502),
        }
    };
    let Some(extension) = image_extension(&content_type) else {
        return json_error("unexpected output format", 500);
    };

    // 変換後のバイト列から作る。10MB の元画像をハッシュにかけない
    let now = epoch_to_iso((Date::now().as_millis() / 1000) as i64);
    let key = image_key(&now, &sha256_hex(&stored)[..KEY_HASH_LEN], extension);
    let size = stored.len();
    let bucket = ctx.env.bucket("IMAGES_BUCKET")?;
    if bucket.head(&key).await?.is_none() {
        bucket
            .put(&key, stored)
            .http_metadata(HttpMetadata {
                content_type: Some(content_type.clone()),
                cache_control: Some("public, max-age=31536000, immutable".into()),
                ..Default::default()
            })
            .execute()
            .await?;
    }

    let base = ctx.env.var("IMAGE_BASE_URL")?.to_string();
    let url = format!("{}/{key}", base.trim_end_matches('/'));
    Response::from_json(&json!({
        "url": url,
        "key": key,
        "content_type": content_type,
        "bytes": size,
    }))
    .map(|r| r.with_status(201))
}
