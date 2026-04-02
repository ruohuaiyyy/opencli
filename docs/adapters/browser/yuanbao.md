# yuanbao

Browser adapter for [Yuanbao Chat](https://yuanbao.tencent.com/chat).

## Commands

| Command | Description |
|---------|-------------|
| `opencli yuanbao status` | Check whether the page is reachable and whether Yuanbao appears logged in |
| `opencli yuanbao new` | Start a new Yuanbao conversation |
| `opencli yuanbao send "..."` | Send a message to the current Yuanbao chat |
| `opencli yuanbao read` | Read the visible Yuanbao conversation |
| `opencli yuanbao ask "..."` | Send a prompt and wait for a reply |
| `opencli yuanbao references "..."` | Ask Yuanbao and return the answer with reference sources as JSON |

## Prerequisites

- Chrome is running
- You are already logged into [yuanbao.tencent.com](https://yuanbao.tencent.com/)
- Playwright MCP Bridge / browser bridge is configured for OpenCLI

## Examples

```bash
opencli yuanbao status
opencli yuanbao new
opencli yuanbao send "帮我总结这段文档"
opencli yuanbao read
opencli yuanbao ask "请写一个 Python 快速排序示例" --timeout 90
opencli yuanbao references "大同旅游景点推荐" -f json
```

## Notes

- The adapter targets the web chat page at `https://yuanbao.tencent.com/chat`
- `new` first tries the visible "New Chat / 新对话" button, then falls back to the chat route
- `ask` uses DOM polling, so very long generations may need a larger `--timeout`
- `references` automatically extracts reference sources (`.hyc-card-box-search-ref`) after AI response completes
- Reference results are saved to `~/.opencli/yuanbao_output/` by default
