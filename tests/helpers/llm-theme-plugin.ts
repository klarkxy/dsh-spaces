import z from "@deepseek-ai/schemastery";

export const name = "spaces-theme";
export const Config = z.object({
  color: z.string().default("gray").volatile(),
});
export function apply(): void {}
apply.Config = Config;
export default apply;
