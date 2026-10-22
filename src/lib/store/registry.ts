/**
 * The store this process is using. The driver is stateless — a handle to one database — so it does not
 * have to travel through every signature: the Node entry sets it once, the Worker entry sets it per
 * request (the same binding every time), and functions default to it.
 */
import type { StoreDriver } from "./driver";

let active: StoreDriver | null = null;

export function setStore(store: StoreDriver): void {
  active = store;
}

export function currentStore(): StoreDriver {
  if (!active) throw new Error("no store configured: call setStore() at startup (both entries do)");
  return active;
}
