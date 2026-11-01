import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
turndown.remove(["script", "style"]);
// Turndown takes only <pre><code> for a code block, the templates hold a bare <pre>
turndown.addRule("pre", {
    filter: "pre",
    replacement: (_content, node) => {
        const code = (node.textContent ?? "").replace(/\n+$/, "");
        const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run: string) => run.length));
        const fence = "`".repeat(Math.max(3, longestRun + 1));
        return `\n\n${ fence }\n${ code }\n${ fence }\n\n`;
    },
});

export function htmlToMarkdown(html: string): string {
    return turndown.turndown(html);
}
