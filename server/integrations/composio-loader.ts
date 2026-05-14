import {
  buildComposioIntegrationModule,
  getComposio,
  listActiveToolkitSlugs,
} from "../composio.js";
import { registerIntegration } from "./registry.js";

export async function registerComposioToolkits(): Promise<void> {
  if (!getComposio()) {
    console.log("[composio] disabled — COMPOSIO_API_KEY not set");
    return;
  }
  const slugs = await listActiveToolkitSlugs();
  if (slugs.length === 0) {
    console.log("[composio] 0 toolkits connected");
    return;
  }
  for (const slug of slugs) {
    registerIntegration(buildComposioIntegrationModule(slug));
  }
  console.log(`[composio] registered ${slugs.length} toolkit(s): ${slugs.join(", ")}`);
}
