# vendor/tree-sitter 来源与许可

P5 L2 语法感知断言层的静态依赖。一次性 vendored、永不手改（`engine/vendor/**` 在
.gitattributes 标记 linguist-generated）；零 npm 运行时依赖不变——这些是静态资产，不是依赖。

| 文件 | 来源 | 许可 |
|---|---|---|
| `tree-sitter.cjs` / `tree-sitter.wasm` | npm `web-tree-sitter@0.22.6`（dist 原样拷贝） | MIT |
| `grammars/tree-sitter-javascript.wasm.br` | npm `tree-sitter-wasms@0.1.13`（brotli -q 11 压缩） | MIT |
| `grammars/tree-sitter-typescript.wasm.br` | 同上（tree-sitter-typescript） | MIT |
| `grammars/tree-sitter-tsx.wasm.br` | 同上（tree-sitter-tsx） | MIT |
| `grammars/tree-sitter-java.wasm.br` | 同上（tree-sitter-java） | MIT |
| `grammars/tree-sitter-python.wasm.br` | 同上（tree-sitter-python） | MIT |
| `grammars/tree-sitter-go.wasm.br` | 同上（tree-sitter-go） | MIT |
| `grammars/tree-sitter-rust.wasm.br` | 同上（tree-sitter-rust） | MIT |

版本配对约束：语法包 dylink 段格式必须与运行时同代——web-tree-sitter 0.26 拒绝
tree-sitter-wasms 0.1.x 构建的语法包（`need dylink.0` 失败）。升级任一侧必须成对验证。

精确 sha256 见 `VENDOR.json`（`reqbank check --vendor` 校验）。
