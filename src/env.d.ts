import type { Page } from "./lib/db";

declare global {
  namespace App {
    interface Locals {
      page?: Page;
    }
  }
}
