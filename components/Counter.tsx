"use client"

import { useState } from "react"
import { useParams } from "../framework/hooks"

export function Counter() {
  const [count, setCount] = useState(0)
  const param = useParams();

  return (
    <div>
      <h2>Counter Component</h2>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Click me</button>
    </div>
  )
}