import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { getBlogPosts } from "@/lib/blog";
import { blogDate } from "@/lib/blog-utils";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Blog",
  description: "Ideas, updates, and notes from the Pragma team.",
};

type Post = ReturnType<typeof getBlogPosts>[number];

function FeaturedMedia({ post }: { post: Post }) {
  if (post.data.video) {
    return (
      <div className="border-border bg-card relative aspect-video overflow-hidden rounded-2xl border">
        <video
          src={post.data.video.src}
          poster={post.data.video.poster}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          className="pointer-events-none size-full object-cover motion-reduce:hidden"
        />
        {post.data.video.poster ? (
          <Image
            src={post.data.video.poster}
            alt=""
            width={1200}
            height={675}
            className="hidden size-full object-cover motion-reduce:block"
          />
        ) : null}
        <span className="bg-background/85 absolute right-4 bottom-4 rounded-full px-4 py-2 text-xs font-medium">
          Watch the launch film →
        </span>
      </div>
    );
  }

  if (post.data.cover) {
    return (
      <div className="border-border bg-card aspect-[1200/760] overflow-hidden rounded-2xl border">
        <Image
          src={post.data.cover.src}
          alt={post.data.cover.alt}
          width={1200}
          height={760}
          priority
          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none"
        />
      </div>
    );
  }

  return null;
}

function FeaturedPost({ post }: { post: Post }) {
  return (
    <section aria-label="Latest post" className="border-border border-b py-10 sm:py-16">
      <Link
        href={post.url}
        className={cn(
          "focus-visible:ring-ring group grid gap-8 rounded-2xl outline-none focus-visible:ring-2 md:items-center md:gap-12",
          (post.data.video || post.data.cover) && "md:grid-cols-2",
        )}
      >
        <FeaturedMedia post={post} />
        <div>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
            Latest · <time dateTime={post.data.date}>{blogDate(post.data.date)}</time>
          </p>
          <h2 className="font-heading type-display-md mt-5 text-balance group-hover:underline group-hover:underline-offset-4 sm:text-5xl">
            {post.data.title}
          </h2>
          <p className="text-muted-foreground mt-5 max-w-lg text-base leading-relaxed">
            {post.data.description}
          </p>
          <span className="mt-8 inline-block text-sm font-medium">Read the story →</span>
        </div>
      </Link>
    </section>
  );
}

function PostArchive({ posts }: { posts: Post[] }) {
  return (
    <section aria-labelledby="more-posts" className="pt-12 sm:pt-16">
      <h2 id="more-posts" className="font-heading text-2xl font-medium tracking-tight">
        More stories
      </h2>
      <ul className="border-border mt-8 border-t">
        {posts.map((post) => (
          <li key={post.url} className="border-border border-b">
            <Link
              href={post.url}
              className="focus-visible:ring-ring group grid gap-3 py-7 outline-none focus-visible:ring-2 sm:grid-cols-[9rem_1fr_auto] sm:items-baseline sm:gap-8"
            >
              <time dateTime={post.data.date} className="text-muted-foreground text-sm">
                {blogDate(post.data.date)}
              </time>
              <span className="font-heading text-xl font-medium group-hover:underline group-hover:underline-offset-4">
                {post.data.title}
              </span>
              <span aria-hidden="true">↗</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Latest story first, followed by the remaining posts in publication order. */
export default function BlogPage() {
  const [latest, ...rest] = getBlogPosts();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 pt-16 pb-24 sm:pt-24">
      <header className="border-border border-b pb-10">
        <h1 className="font-heading type-display-lg">From the workspace.</h1>
        <p className="text-muted-foreground mt-5 max-w-xl text-lg leading-relaxed">
          Notes on building with agents, keeping context, and making space for better ideas.
        </p>
      </header>
      {latest ? <FeaturedPost post={latest} /> : null}
      {rest.length > 0 ? <PostArchive posts={rest} /> : null}
    </main>
  );
}
