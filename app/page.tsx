// app/page.tsx
async function getProducts() {
  return ["Apples", "Bananas", "Oranges"]
}

async function ProductList() {
  const items = await getProducts()

  return (
    <ul>
      {items.map(item => <li key={item}>{item}</li>)}
    </ul>
  )
}

import { Counter } from "../components/Counter.tsx"

export default async function Page() {
  const productList = await ProductList()

  return (
    <div>
      <h1>BunFrame</h1>
      <p>This is the home page.</p>
      {productList}
      <div id="counter-root">
        <Counter />
      </div>
    </div>
  )
}