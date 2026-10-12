use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use worker::*;

use crate::util::{image_extension, image_key, is_animated, sniff_image, ImageKind};
use crate::{epoch_to_iso, is_admin, json_error};

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_EDGE: u32 = 2000;
const AVIF_QUALITY: u32 = 70;
const KEY_HASH_LEN: usize = 16;

#[wasm_bindgen]
extern "C" {
    /// Cloudflare の Images バインディング（`env.IMAGES`）。workers-rs にラッパーが無い。
    type Images;

    #[wasm_bindgen(method)]
    fn input(this: &Images, stream: &web_sys::ReadableStream) -> ImageTransformer;

    type ImageTransformer;

    #[wasm_bindgen(method)]
    fn transform(this: &ImageTransformer, options: &JsValue) -> ImageTransformer;

    #[wasm_bindgen(method)]
    fn output(this: &ImageTransformer, options: &JsValue) -> js_sys::Promise;

    type ImageResult;

    #[wasm_bindgen(method)]
    fn response(this: &ImageResult) -> web_sys::Response;
}

fn to_stream(bytes: &[u8]) -> Result<web_sys::ReadableStream> {
    let array = js_sys::Uint8Array::from(bytes);
    let response = web_sys::Response::new_with_opt_buffer_source(Some(&array))
        .map_err(|e| Error::JsError(format!("{e:?}")))?;
    response
        .body()
        .ok_or_else(|| Error::JsError("empty body".into()))
}

fn js_object(entries: &[(&str, JsValue)]) -> JsValue {
    let object = js_sys::Object::new();
    for (key, value) in entries {
        let _ = js_sys::Reflect::set(&object, &JsValue::from_str(key), value);
    }
    object.into()
}

/// 長辺を `MAX_EDGE` 以下に縮めて AVIF にする。拡大はしない。
/// 失敗（壊れた画像、Images が読めない形式）は `None`。出力の形式は Images が決める。
async fn to_avif(images: &Images, bytes: &[u8]) -> Result<Option<(Vec<u8>, String)>> {
    let transformer = images.input(&to_stream(bytes)?).transform(&js_object(&[
        ("width", MAX_EDGE.into()),
        ("height", MAX_EDGE.into()),
        ("fit", "scale-down".into()),
    ]));
    let options = js_object(&[
        ("format", "image/avif".into()),
        ("quality", AVIF_QUALITY.into()),
    ]);
    let Ok(result) = JsFuture::from(transformer.output(&options)).await else {
        return Ok(None);
    };
    let response: Response = result.unchecked_into::<ImageResult>().response().into();
    let content_type = response.headers().get("Content-Type")?.unwrap_or_default();
    let mut response = response;
    Ok(Some((response.bytes().await?, content_type)))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `POST /api/images`。本文は画像のバイト列そのもの。
/// 長辺 2000px の AVIF にして R2 に置く。アニメーションを持つ画像は変換せずそのまま置く。
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
        (bytes.clone(), content_type.to_string())
    } else {
        let images: Images = js_sys::Reflect::get(&ctx.env, &JsValue::from_str("IMAGES"))
            .map_err(|_| Error::JsError("IMAGES binding is missing".into()))?
            .unchecked_into();
        match to_avif(&images, &bytes).await? {
            Some(converted) => converted,
            None => return json_error("could not read the image", 422),
        }
    };
    let Some(extension) = image_extension(&content_type) else {
        return json_error("unexpected output format", 500);
    };

    let now = epoch_to_iso((Date::now().as_millis() / 1000) as i64);
    let key = image_key(&now, &sha256_hex(&bytes)[..KEY_HASH_LEN], extension);
    let bucket = ctx.env.bucket("IMAGES_BUCKET")?;
    if bucket.head(&key).await?.is_none() {
        bucket
            .put(&key, stored.clone())
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
        "bytes": stored.len(),
    }))
    .map(|r| r.with_status(201))
}
