import { register, catalog, lowStock } from "./inventory";
import { saveCustomer, getCustomer } from "./customer";
import { Cart } from "./cart";
import { createOrder } from "./orders";
import { sortByPrice } from "./utils";
import { format } from "./money";
import { Product, Customer } from "./types";

const laptop: Product = { id: "p1", name: "Laptop", price: 999.99, stock: 3 };
const mouse: Product = { id: "p2", name: "Mouse", price: 25.5, stock: 100 };
const keyboard: Product = { id: "p3", name: "Keyboard", price: 79.0, stock: 40 };
const monitor: Product = { id: "p4", name: "Monitor", price: 249.99, stock: 8 };

for (const product of [laptop, mouse, keyboard, monitor]) {
  register(product);
}

/** Print the catalog cheapest-first. Uses a copy so internal state is untouched. */
function printCatalog(): void {
  const sorted = sortByPrice(catalog());
  for (const product of sorted) {
    console.log(`${product.name.padEnd(12)} ${format(product.price)}  (stock: ${product.stock})`);
  }
}

const alice: Customer = {
  id: "c1",
  name: "Alice",
  email: "alice@example.com",
  vip: true,
  creditCard: "4111111111111111",
};
saveCustomer(alice);

printCatalog();

const cart = new Cart();
cart.addItem(laptop, 2);
cart.addItem(mouse, 12);
cart.addItem(laptop, 1);

createOrder(getCustomer("c1"), cart, ["save10"]);

const reorder = lowStock();
if (reorder.length > 0) {
  console.log("Reorder needed for: " + reorder.map((p) => p.name).join(", "));
}

console.log("done");
