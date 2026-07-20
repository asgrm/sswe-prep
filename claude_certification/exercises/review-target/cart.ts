import { CartItem, Product } from "./types";
import { subtotal } from "./pricing";

export class Cart {
  items: CartItem[] = [];

  addItem(product: Product, quantity: number) {
    this.items.push({ product, quantity });
  }

  removeProduct(productId: string) {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].product.id === productId) {
        this.items.splice(i, 1);
      }
    }
  }

  total(): number {
    return subtotal(this.items);
  }

  /** True when the cart has no line items. */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Total number of units across all lines. */
  count(): number {
    return this.items.reduce((acc, item) => acc + item.quantity, 0);
  }

  /** Find the first line for a product, if any. */
  findLine(productId: string): CartItem | undefined {
    return this.items.find((item) => item.product.id === productId);
  }

  /** Set the quantity of an existing line; returns false if not found. */
  setQuantity(productId: string, quantity: number): boolean {
    const line = this.findLine(productId);
    if (!line) {
      return false;
    }
    line.quantity = quantity;
    return true;
  }

  /** Remove every line and start fresh. */
  clear(): void {
    this.items = [];
  }

  /** A read-only snapshot of the current lines. */
  snapshot(): CartItem[] {
    return this.items.map((item) => ({ ...item }));
  }
}
