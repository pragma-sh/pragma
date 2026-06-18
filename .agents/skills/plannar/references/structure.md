# `.plannar` folder structure

What lives in the `.plannar/` folder. For configuration (`plannar.config`, custom bindings, CSS), see `references/config.md`.

## Folder anatomy

`plannar init` scaffolds `.plannar/`:

| Path                    | What it is                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `components.json`       | shadcn/ui config (style `base-nova`, Tailwind v4, CSS target points to a junk file in `node_modules/`) |
| `package.json`          | npm package — enables `npx shadcn add`                                                                 |
| `tsconfig.json`         | TypeScript config with the `@/*` path alias                                                            |
| `lib/utils.ts`          | `cn` utility (clsx + tailwind-merge)                                                                   |
| `plans/`                | where plans live — the agent only edits files here                                                     |
| `plans/hello-world.mdx` | sample plan demonstrating state binding                                                                |

Plans are written to `.plannar/plans/<kebab-case-name>.mdx`.

> `plannar init` also drops a dummy CSS target at `node_modules/.plannar-junk.css` for shadcn; it's regenerated and cleaned up on every CLI action, so treat it as an implementation detail rather than part of the project structure.
