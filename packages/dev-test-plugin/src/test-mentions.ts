import { defineContextProvider } from "@pragma-sh/plugin";

/** Canned `@` mentions for exercising the prompt context picker end to end. */
const TEST_MENTIONS = [
  {
    id: "hello",
    displayName: "dev-hello",
    description: "A greeting from the dev test plugin",
    content:
      "Hello from the Pragma dev test plugin. Reply with the word PINEAPPLE to prove you read this.",
  },
  {
    id: "project",
    displayName: "dev-project",
    description: "The active project and worktree",
    content: "",
  },
] as const;

type TestMentionId = (typeof TEST_MENTIONS)[number]["id"];

/** `@` context provider that offers {@link TEST_MENTIONS} and resolves them to fixed text. */
export const testMentionsProvider = defineContextProvider<unknown, { id: TestMentionId }>({
  id: "test-mentions",
  title: "Dev test mentions",
  search: () =>
    TEST_MENTIONS.map((mention) => ({
      id: mention.id,
      displayName: mention.displayName,
      description: mention.description,
      data: { id: mention.id },
    })),
  resolve: ({ item, project, worktree }) => {
    if (item.data?.id === "project") {
      return [
        `Project: ${project?.name ?? "(none)"}`,
        `Worktree: ${worktree ? `${worktree.branch} at ${worktree.path}` : "(none)"}`,
      ].join("\n");
    }
    return TEST_MENTIONS.find((mention) => mention.id === item.data?.id)?.content ?? "";
  },
});
