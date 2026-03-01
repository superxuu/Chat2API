const text = `[function_calls] [invoke name="write_to_file"]
{
  "filePath": "test.py",
  "content": "print('hello')"
}
[/function_calls]`

const blockRegex = /\[function_calls\]([\s\S]*?)(?:\[\/function_calls\]|$)/g
const blockMatch = blockRegex.exec(text)
console.log("Block match:", blockMatch ? "Yes" : "No")

if (blockMatch) {
  const blockContent = blockMatch[1]
  console.log("Block content:", blockContent)
  
  const callStartRegex = /\[invoke\s+name="([a-zA-Z0-9_:-]+)"\]/g
  let callStartMatch
  while ((callStartMatch = callStartRegex.exec(blockContent)) !== null) {
    console.log("Call match:", callStartMatch[0])
    console.log("Function name:", callStartMatch[1])
  }
}
