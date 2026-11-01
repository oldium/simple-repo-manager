import dedent from "dedent";
import { htmlToMarkdown } from "../../server/lib/html-markdown.ts";

describe("htmlToMarkdown", () => {
    test("A bare <pre> becomes a code block with its text as it is", () => {
        const html = dedent`
            <pre>sudo tee /etc/apt/sources.list.d/repo.sources >/dev/null <<'EOF'
            Types: deb deb-src
              URIs: https://repo.example.com/deb/debian?a=1&amp;b=&lt;2&gt;
            Name: &#39;Repo&#39; &quot;x&quot;
            EOF
            </pre>`;

        expect(htmlToMarkdown(html)).toBe(dedent`
            \`\`\`
            sudo tee /etc/apt/sources.list.d/repo.sources >/dev/null <<'EOF'
            Types: deb deb-src
              URIs: https://repo.example.com/deb/debian?a=1&b=<2>
            Name: 'Repo' "x"
            EOF
            \`\`\``);
    });

    test("Code holding a fence gets a longer one", () => {
        expect(htmlToMarkdown("<pre>a\n```\nb</pre>")).toBe("````\na\n```\nb\n````");
    });

    test("Blocks stay apart, in their order", () => {
        expect(htmlToMarkdown("<pre>first</pre>\n<pre>second\n</pre>\n")).toBe("```\nfirst\n```\n\n```\nsecond\n```");
    });

    test("What a custom template may hold around the commands comes through", () => {
        const html = dedent`
            <h2>For <em>this</em> release</h2>
            <p>See the <a href="https://example.com/docs">docs</a>:</p>
            <ul><li>first</li><li><code>second</code></li></ul>`;

        expect(htmlToMarkdown(html)).toBe(dedent`
            ## For _this_ release

            See the [docs](https://example.com/docs):

            -   first
            -   \`second\``);
    });

    test("Scripts and styles are not instructions", () => {
        expect(htmlToMarkdown("<style>p { color: red }</style><script>alert(1)</script><p>text</p>")).toBe("text");
    });
});
