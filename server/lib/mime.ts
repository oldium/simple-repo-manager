import path from "node:path";
import mime from "mime-types";

export function mimeTypeFor(filename: string): string {
    const basename = path.basename(filename);

    if (filename.endsWith(".deb") || filename.endsWith(".ddeb") || filename.endsWith(".udeb")) {
        return "application/vnd.debian.binary-package";
    }
    if (filename.endsWith(".dsc")) return "text/plain";
    if (filename.endsWith(".rpm")) return "application/x-rpm";
    if (basename === "Release" || basename === "Packages") return "text/plain";

    return mime.lookup(filename) || "application/octet-stream";
}
