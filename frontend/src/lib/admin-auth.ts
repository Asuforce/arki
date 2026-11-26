import { AccessUnavailableError, verifyAccessCookie } from "./access";
import { devBypass, loadAccessConfig } from "./access-config";

/** 公開ページ側で `CF_Authorization` クッキー（または開発バイパス）から管理者かどうかを判定する。 */
export async function isAdminRequest(request: Request): Promise<boolean> {
  if (devBypass()) return true;
  const config = loadAccessConfig();
  if (!config) return false;
  try {
    return (await verifyAccessCookie(request.headers.get("Cookie"), config)) !== null;
  } catch (error) {
    if (error instanceof AccessUnavailableError) return false;
    throw error;
  }
}
