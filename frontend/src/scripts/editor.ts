import { buildPayload, sameSnapshot, type Snapshot } from "../lib/editor-state";

interface EditorData {
  id: number | null;
  title: string;
  content: string;
  categories: string[];
  status: "draft" | "published";
  slug: string;
  slugFixed: boolean;
  date: string;
  dateUnset: boolean;
  updatedAt: string | null;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const data = JSON.parse($("editor-data").textContent ?? "{}") as EditorData;
const titleInput = $<HTMLInputElement>("title");
const contentInput = $<HTMLTextAreaElement>("content");
const dateInput = $<HTMLInputElement>("date");
const slugInput = $<HTMLInputElement>("slug");
const slugEdit = $<HTMLInputElement>("slug-edit");
const chips = $("chips");
const categoryInput = $<HTMLInputElement>("category-input");
const preview = $("preview");
const panes = document.querySelector<HTMLElement>(".panes")!;
const banner = $("banner");
const stateLabel = $("state");
const saveButton = $<HTMLButtonElement>("save");
const toggleButton = $<HTMLButtonElement>("toggle-status");

let categories = [...data.categories];
let status = data.status;
let updatedAt = data.updatedAt;
let slug = data.slug;
let busy = false;
let pendingUploads = 0;
let uploadSeq = 0;

contentInput.value = data.content;

const snapshot = (): Snapshot => ({
  title: titleInput.value.trim(),
  content: contentInput.value,
  categories: [...categories],
  date: dateInput.value,
});
let saved: Snapshot = snapshot();
const isDirty = (): boolean => !sameSnapshot(snapshot(), saved);

function applySnapshot(s: Snapshot): void {
  titleInput.value = s.title;
  contentInput.value = s.content;
  dateInput.value = s.date;
  categories = [...s.categories];
  renderChips();
  renderPreview();
}

const backupKey = `arki-backup:${data.id ?? "new"}`;
const conflictKey = `arki-conflict:${data.id ?? "new"}`;

interface Backup {
  snapshot: Snapshot;
  base: string | null;
}

function storeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function storeSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}
function storeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
}

let backupTimer: number | undefined;
function scheduleBackup(): void {
  window.clearTimeout(backupTimer);
  backupTimer = window.setTimeout(() => {
    if (isDirty()) storeSet(backupKey, { snapshot: snapshot(), base: updatedAt } satisfies Backup);
    else storeRemove(backupKey);
  }, 400);
}

function showState(text: string): void {
  stateLabel.textContent = text;
}

function showBanner(message: string, actions: { label: string; run: () => void }[] = []): void {
  banner.hidden = false;
  banner.replaceChildren(document.createTextNode(message));
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      action.run();
      banner.hidden = true;
    });
    banner.append(button);
  }
}

function markDirty(): void {
  showState(isDirty() ? "未保存" : stateLabel.dataset.saved ?? "");
  scheduleBackup();
}

function renderChips(): void {
  chips.querySelectorAll(".chip").forEach((el) => el.remove());
  for (const name of categories) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `${name} を外す`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      categories = categories.filter((c) => c !== name);
      renderChips();
      markDirty();
    });
    chip.append(remove);
    chips.insertBefore(chip, categoryInput);
  }
}

function addCategory(raw: string): void {
  const name = raw.trim();
  if (name && !categories.includes(name)) {
    categories.push(name);
    renderChips();
    markDirty();
  }
  categoryInput.value = "";
}

categoryInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    addCategory(categoryInput.value);
  } else if (event.key === "Backspace" && !categoryInput.value && categories.length) {
    categories.pop();
    renderChips();
    markDirty();
  }
});
categoryInput.addEventListener("change", () => addCategory(categoryInput.value));

let previewTimer: number | undefined;
let previewAbort: AbortController | undefined;
function renderPreview(): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    previewAbort?.abort();
    previewAbort = new AbortController();
    try {
      const res = await fetch("/admin/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: contentInput.value }),
        signal: previewAbort.signal,
      });
      if (res.ok) preview.innerHTML = ((await res.json()) as { html: string }).html;
    } catch {
      return;
    }
  }, 350);
}

document.querySelectorAll<HTMLButtonElement>(".pane-tabs [data-pane]").forEach((tab) => {
  tab.addEventListener("click", () => {
    panes.dataset.active = tab.dataset.pane;
    document.querySelectorAll(".pane-tabs [data-pane]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    if (tab.dataset.pane === "preview") renderPreview();
  });
});

for (const el of [titleInput, contentInput, dateInput]) {
  el.addEventListener("input", () => {
    markDirty();
    if (el === contentInput) renderPreview();
  });
}

slugEdit.addEventListener("change", () => {
  slugInput.readOnly = !slugEdit.checked;
  if (slugEdit.checked) slugInput.focus();
  else slugInput.value = slug;
});

function setBusy(value: boolean): void {
  busy = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".actions button")) button.disabled = value;
}

const now = (): string => new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

async function save(nextStatus: "draft" | "published" = status): Promise<void> {
  if (busy) return;
  if (pendingUploads > 0) {
    showState("画像のアップロードが終わってから保存してください");
    return;
  }
  const current = snapshot();
  if (!current.title) {
    showState("題名を入れてください");
    titleInput.focus();
    return;
  }
  const payload = buildPayload(current, saved, {
    status: nextStatus,
    updatedAt,
    slug: { enabled: slugEdit.checked, value: slugInput.value.trim(), current: slug },
  });
  if ("error" in payload) {
    showState(String(payload.error));
    return;
  }

  setBusy(true);
  showState("保存しています…");
  try {
    const res = await fetch(data.id ? `/admin/api/posts/${data.id}` : "/admin/api/posts", {
      method: data.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: number; slug?: string; updated_at?: string; error?: string };
    if (res.status === 409 && data.id && body.updated_at) {
      await handleConflict(current);
      return;
    }
    if (!res.ok) {
      showState(body.error === "slug already exists" ? "slug が重複しています" : `保存に失敗しました（${body.error ?? res.status}）`);
      return;
    }
    storeRemove(backupKey);
    storeRemove(conflictKey);
    // 初回公開や公開状態の切り替えは、slug と公開日時が変わりうる。保存済みの姿を読み直す
    if (!data.id || nextStatus !== status || body.slug !== slug) {
      // 保存中に打ち足した分は、遷移先の編集画面が復元を申し出る
      window.clearTimeout(backupTimer);
      const live = snapshot();
      if (!sameSnapshot(live, current)) storeSet(`arki-backup:${body.id ?? data.id}`, { snapshot: live, base: body.updated_at ?? null } satisfies Backup);
      window.removeEventListener("beforeunload", warnUnsaved);
      location.assign(`/admin/edit/${body.id ?? data.id}`);
      return;
    }
    saved = current;
    updatedAt = body.updated_at ?? updatedAt;
    stateLabel.dataset.saved = `${now()} に保存しました`;
    showState(stateLabel.dataset.saved);
  } catch {
    showState("通信に失敗しました。入力は端末に退避しています");
  } finally {
    setBusy(false);
  }
}

async function handleConflict(mine: Snapshot): Promise<void> {
  storeSet(conflictKey, mine);
  const res = await fetch(`/admin/api/posts/${data.id}`);
  if (!res.ok) {
    showState("他の端末で更新されています。入力は端末に退避しました");
    return;
  }
  const latest = (await res.json()) as { title: string; content: string; categories: string[]; published_at: string; date_unset: boolean; updated_at: string; slug: string; status: "draft" | "published" };
  updatedAt = latest.updated_at;
  slug = latest.slug;
  status = latest.status;
  toggleButton.textContent = status === "published" ? "下書きに戻す" : "公開する";
  slugEdit.checked = false;
  slugInput.readOnly = true;
  slugInput.value = slug;
  const { toJstInput } = await import("../lib/jst");
  saved = {
    title: latest.title.trim(),
    content: latest.content,
    categories: [...latest.categories],
    date: latest.date_unset ? "" : toJstInput(latest.published_at),
  };
  applySnapshot(saved);
  showState("他の端末で更新されていました");
  showBanner("他の端末で更新されていたので、最新を読み込みました。あなたの編集は端末に退避してあります。", [
    {
      label: "自分の版に戻す",
      run: () => {
        applySnapshot(mine);
        markDirty();
      },
    },
  ]);
}

saveButton.addEventListener("click", () => void save());
toggleButton.addEventListener("click", () => void save(status === "published" ? "draft" : "published"));
document.getElementById("delete")?.addEventListener("click", async () => {
  if (!confirm(`「${titleInput.value || "この記事"}」を削除します。元に戻せません。`)) return;
  const res = await fetch(`/admin/api/posts/${data.id}`, { method: "DELETE" });
  if (res.ok) {
    storeRemove(backupKey);
    window.removeEventListener("beforeunload", warnUnsaved);
    location.assign("/admin");
  } else {
    showState(`削除に失敗しました（${res.status}）`);
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    void save();
  }
});

function warnUnsaved(event: BeforeUnloadEvent): void {
  if (isDirty()) event.preventDefault();
}
window.addEventListener("beforeunload", warnUnsaved);

const ERRORS: Record<number, string> = {
  413: "10MB 以下の画像にしてください",
  415: "png、jpeg、gif、webp だけ入れられます",
  422: "画像を読めませんでした",
  502: "画像の変換に失敗しました",
};

async function uploadImage(file: File): Promise<void> {
  const placeholder = `![アップロード中 #${++uploadSeq}]()`;
  pendingUploads++;
  contentInput.setRangeText(placeholder, contentInput.selectionStart, contentInput.selectionEnd, "end");
  markDirty();
  const replace = (text: string): void => {
    const at = contentInput.value.indexOf(placeholder);
    if (at < 0) {
      if (text) showState("アップロード中の行が消えていたので、画像は入れませんでした");
      return;
    }
    contentInput.setRangeText(text, at, at + placeholder.length, "preserve");
    markDirty();
    renderPreview();
  };
  try {
    const res = await fetch("/admin/api/images", { method: "POST", body: file });
    const body = (await res.json().catch(() => ({}))) as { url?: string };
    if (res.ok && body.url) {
      replace(`![](${body.url})`);
    } else {
      replace("");
      showState(ERRORS[res.status] ?? `画像のアップロードに失敗しました（${res.status}）`);
    }
  } catch {
    replace("");
    showState("画像のアップロードに失敗しました");
  } finally {
    pendingUploads--;
  }
}

const imageFiles = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

contentInput.addEventListener("paste", (event) => {
  const files = imageFiles(event.clipboardData?.files);
  if (!files.length) return;
  event.preventDefault();
  files.forEach((f) => void uploadImage(f));
});
contentInput.addEventListener("dragover", (event) => event.preventDefault());
contentInput.addEventListener("drop", (event) => {
  const files = imageFiles(event.dataTransfer?.files);
  if (!files.length) return;
  event.preventDefault();
  files.forEach((f) => void uploadImage(f));
});
const fileInput = $<HTMLInputElement>("image-file");
$("add-image").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  imageFiles(fileInput.files).forEach((f) => void uploadImage(f));
  fileInput.value = "";
});

renderChips();
renderPreview();
const conflictCopy = storeGet<Snapshot>(conflictKey);
const backup = storeGet<Backup>(backupKey);
if (conflictCopy && !sameSnapshot(conflictCopy, saved)) {
  showBanner("他の端末と競合したときの、あなたの編集が端末に残っています。", [
    {
      label: "復元する",
      run: () => {
        applySnapshot(conflictCopy);
        markDirty();
      },
    },
    { label: "捨てる", run: () => storeRemove(conflictKey) },
  ]);
} else if (backup?.snapshot && !sameSnapshot(backup.snapshot, saved)) {
  showBanner("保存していない編集が端末に残っています。", [
    {
      label: "復元する",
      run: () => {
        // 退避したときの版を引き継ぎ、そのあとに他の端末で更新されていたら保存で競合として扱う
        updatedAt = backup.base;
        applySnapshot(backup.snapshot);
        markDirty();
      },
    },
    { label: "捨てる", run: () => storeRemove(backupKey) },
  ]);
}
