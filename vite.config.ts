import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { "@": path.resolve(__dirname, "./src") },
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks: {
					// Vendor chunks - split large dependencies
					"vendor-react": ["react", "react-dom", "react-router-dom"],
					// HEIC converter loaded only when needed
					"heic-converter": ["heic2any"],
				},
			},
		},
		// Raise warning limit since we're now properly splitting
		chunkSizeWarningLimit: 600,
	},
});
