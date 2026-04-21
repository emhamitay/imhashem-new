// app/page.tsx
function ProductList() {
  const items = ["Apples", "Bananas", "Oranges"]

  return (
    <ul>
      {items.map(item => <li key={item}>{item}</li>)}
    </ul>
  )
}

import { Counter } from "../components/Counter.tsx"

export default function Page() {
  return (
    <div>
      <h1>BunFrame</h1>
      <ProductList />
      <Counter />
    </div>
  )
}