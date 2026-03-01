# 逆向工程指南：基于 Prompt 的通用工具调用实现方案

本文档详细解析了本项目（Gemini-FastAPI-Zeabur）如何通过 Prompt Engineering 和流式解析技术，在不依赖原生 Function Calling API 的情况下，实现兼容 OpenAI 格式的工具调用功能。

这种方案具有极高的通用性，适用于任何具备指令遵循能力的 LLM（如 Llama 3, Claude, Mistral 等），是逆向工程中扩展模型能力的经典模式。

---

## 核心原理

该方案的核心思想是将“工具调用”转化为“文本生成”任务：

1.  **协议定义**：设计一套模型容易理解且易于解析的文本协议（如 `[call:tool_name]{args}[/call]`）。
2.  **Prompt 注入**：将工具定义转换为 System Prompt，教会模型使用该协议。
3.  **输出拦截**：在流式传输中实时拦截协议文本，阻止其显示给用户。
4.  **解析与还原**：提取协议内容，解析为 JSON，并封装为 OpenAI 格式的 `tool_calls` 返回。

---

## 1. 协议设计 (Protocol Design)

为了避免模型生成的普通文本与工具调用混淆，我们需要设计一套具有独特特征的标记语言。

**本项目采用的协议格式：**

```text
[function_calls]
[call:get_weather]{"location": "Beijing", "unit": "celsius"}[/call]
[call:search_web]{"query": "latest news"}[/call]
[/function_calls]
```

*   **外层包裹**：`[function_calls]...[/function_calls]` 明确标识这是一个工具调用块。
*   **调用单元**：`[call:name]...[/call]` 标识具体的函数名。
*   **参数载体**：中间的内容必须是标准的 JSON 对象。

---

## 2. Prompt 构建 (Prompt Engineering)

我们需要将 OpenAI 格式的 `tools` 定义转换为模型能理解的自然语言描述。

### 2.1 工具描述转换

将 JSON Schema 转换为易读的文本描述。

```python
def _build_tool_prompt(tools: list[Tool], tool_choice: str | ToolChoiceFunction | None) -> str:
    lines = [
        "You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments."
    ]

    for tool in tools:
        function = tool.function
        description = function.description or "No description provided."
        # 1. 声明工具名称和描述
        lines.append(f"Tool `{function.name}`: {description}")
        
        # 2. 附上参数 Schema
        if function.parameters:
            schema_text = json.dumps(function.parameters)
            lines.append("Arguments JSON schema:")
            lines.append(schema_text)
    
    # ... (协议说明部分，见下文)
    return "\n".join(lines)
```

### 2.2 协议强制说明

在 Prompt 的末尾，必须严格规定输出格式，这是成功的关键。

```python
    # ... (接上文)
    lines.append(
        "When you decide to call a tool you MUST respond with nothing except a single [function_calls] block exactly like the template below."
    )
    lines.append("[function_calls]")
    lines.append('[call:tool_name]{"argument": "value"}[/call]')
    lines.append("[/function_calls]")
    lines.append(
        "CRITICAL: The content inside [call:...]...[/call] MUST be a raw JSON object. Do not wrap it in ```json blocks."
    )
```

### 2.3 强化策略 (Attention Reinforcement)

为了防止模型遗忘指令，我们在**用户最后一条消息**后追加一段简短的提示（Hint）。

```python
TOOL_WRAP_HINT = (
    "\nYou MUST wrap every tool call response inside a single [function_calls] block exactly like:\n"
    '[function_calls]\n[call:tool_name]{"argument": "value"}[/call]\n[/function_calls]\n'
)

def _append_tool_hint_to_last_user_message(messages: list[Message]):
    # 找到最后一条用户消息，追加提示
    # 这利用了 LLM 对 Context 末尾信息关注度最高的特性
    last_msg = messages[-1]
    last_msg.content += TOOL_WRAP_HINT
```

---

## 3. 流式解析与拦截 (Streaming Parser)

这是逆向工程中最具技术含量的部分。我们需要一个状态机（State Machine）来实时处理字符流。

### 3.1 状态机逻辑

解析器需要维护当前状态（如 `NORMAL`, `IN_TOOL_BLOCK`, `IN_CALL_ARGS`），并根据输入的字符流进行状态流转。

```python
class StreamingOutputFilter:
    def __init__(self):
        self.buffer = ""
        self.state = "NORMAL"
        self.TOOL_START = "[function_calls]"
        
    def process(self, chunk: str) -> list[dict]:
        self.buffer += chunk
        events = []
        
        while self.buffer:
            if self.state == "NORMAL":
                # 检查缓冲区是否包含协议起始标记
                idx = self.buffer.find(self.TOOL_START)
                if idx != -1:
                    # 发现工具调用开始！
                    # 1. 输出之前的普通文本
                    if idx > 0:
                        events.append({"type": "text", "content": self.buffer[:idx]})
                    
                    # 2. 切换状态，丢弃标记文本（拦截）
                    self.buffer = self.buffer[idx + len(self.TOOL_START):]
                    self.state = "IN_TOOL_BLOCK"
                else:
                    # 未发现标记，但需保留部分缓冲区以防标记被切断
                    # (例如 "[function_" 在当前块，"calls]" 在下一块)
                    keep_len = len(self.TOOL_START) - 1
                    if len(self.buffer) > keep_len:
                        # 安全输出确认不是标记的部分
                        out = self.buffer[:-keep_len]
                        events.append({"type": "text", "content": out})
                        self.buffer = self.buffer[-keep_len:]
                    break
            
            elif self.state == "IN_TOOL_BLOCK":
                # 解析具体的 [call:name] 和参数...
                # (此处省略具体正则匹配代码，逻辑同上)
                pass
                
        return events
```

### 3.2 鲁棒性处理 (Robustness)

LLM 生成的 JSON 经常会有小错误，解析器必须具备容错能力。

```python
def safe_json_loads(s: str) -> Any:
    """尝试修复并解析不完美的 JSON"""
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    # 常见错误修复策略：
    # 1. 去除 Markdown 代码块 (```json ... ```)
    s = re.sub(r"```(?:json)?\s*(.*?)\s*```", r"\1", s, flags=re.DOTALL)
    
    # 2. 修复单引号 (Python dict style -> JSON)
    # 3. 补全未闭合的括号 (常见于流式截断)
    # 4. 移除尾部逗号
    
    # ... (尝试再次解析)
    return orjson.loads(s)
```

---

## 4. 格式还原 (Response Construction)

最后，将解析出的数据封装回 OpenAI 兼容的格式。

```python
def _create_chat_completion_payload(completion_id, model, text, tool_calls):
    finish_reason = "stop"
    
    # 如果解析出了工具调用
    if tool_calls:
        finish_reason = "tool_calls"
        
        # 转换为 OpenAI ToolCall 对象
        openai_tool_calls = [
            {
                "id": f"call_{uuid.uuid4().hex[:24]}",
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": json.dumps(tc.arguments)
                }
            }
            for tc in tool_calls
        ]
    else:
        openai_tool_calls = None

    return {
        "id": completion_id,
        "object": "chat.completion",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": text, # 如果是纯工具调用，这里通常为 null
                    "tool_calls": openai_tool_calls
                },
                "finish_reason": finish_reason
            }
        ],
        # ...
    }
```

---

## 总结

通过这套方案，我们成功地在 Gemini 逆向接口上实现了标准的 OpenAI Tool Calling 能力。

**关键点回顾：**
1.  **协议唯一性**：使用 `[call:...]` 等非常见标记，防止误判。
2.  **Prompt 强化**：在 System Prompt 和 User Message 结尾双重强调格式。
3.  **流式拦截**：使用状态机在流式传输中“隐形”地处理协议文本。
4.  **容错解析**：专门处理 LLM 输出的不规范 JSON。
