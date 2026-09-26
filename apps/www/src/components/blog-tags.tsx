import { Badge } from "@/components/ui/badge";
import { type BlogTag, blogTagLabels } from "@/lib/blog-utils";

/** A post's frontmatter tags as pills; renders nothing for an untagged post. */
export function BlogTags({ tags }: { tags: readonly BlogTag[] }) {
  if (tags.length === 0) return null;

  return (
    <ul aria-label="Tags" className="flex flex-wrap gap-2">
      {tags.map((tag) => (
        <li key={tag}>
          <Badge variant="outline">{blogTagLabels[tag]}</Badge>
        </li>
      ))}
    </ul>
  );
}
