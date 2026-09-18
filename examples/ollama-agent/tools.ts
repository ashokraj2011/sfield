// ollama-agent/tools.ts — complete
import { defineTool } from "@sfield/core";

const orders = new Map([["A-1001", { id: "A-1001", status: "shipped", total_minor: 4599, currency: "INR" }]]);

export const tools = [
  defineTool({
    id: "orders.get", version: "1.0.0",
    description: "Get an order by its ID.",
    inputs:  { type: "object", additionalProperties: false, required: ["order_id"], properties: { order_id: { type: "string" } } },
    outputs: { type: "object", additionalProperties: false, required: ["id", "status", "total_minor", "currency"],
               properties: { id: { type: "string" }, status: { type: "string" }, total_minor: { type: "integer" }, currency: { type: "string" } } },
    authorization: { action: "order.read", resource: { type: "order", id: { ref: "inputs.order_id" } } },
    async handler({ order_id }) {
      const order = orders.get(String(order_id));
      if (!order) throw new Error("NOT_FOUND");
      return order;
    },
  }),
];
