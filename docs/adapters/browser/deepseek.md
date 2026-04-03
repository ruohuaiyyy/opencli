# deepseek

Browser adapter for [DeepSeek Chat](https://chat.deepseek.com).

## Commands

| Command | Description |
|---------|-------------|
| `opencli deepseek references "..."` | Ask DeepSeek and return the answer with reference sources as JSON |

## Prerequisites

- Chrome is running
- You are already logged into [chat.deepseek.com](https://chat.deepseek.com/)
- Playwright MCP Bridge / browser bridge is configured for OpenCLI

## Examples

```bash
opencli deepseek references "大同旅游景点推荐" -f json
opencli deepseek references "帮我总结这段文档" --timeout 120
opencli deepseek references "Python 快速排序示例" --output my-query.json
```

## Notes

- The adapter targets the web chat page at `https://chat.deepseek.com`
- `references` automatically enables internet search ("智能搜索") to include reference sources
- Response polling uses content length growth detection — when page content stops growing for 5 consecutive checks, AI is done
- Reference results are extracted from the "搜索结果" side panel after clicking "N 个网页" button
- Results are saved to `~/.opencli/deepseek_output/` by default
- Supports both textarea and contenteditable input methods for maximum compatibility
