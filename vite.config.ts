import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rpcTarget = process.env.WEAVE_DEV_RPC_URL ?? "http://127.0.0.1:4310";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/rpc": rpcTarget,
    },
  },
  preview: {
    proxy: {
      "/rpc": rpcTarget,
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
