import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { blogSource, getBlogPost } from "@/lib/blog";
import { blogDate } from "@/lib/blog-utils";
import { blogRoute } from "@/lib/shared";

/** Pre-render all published articles. */
export function generateStaticParams() {
  return blogSource.generateParams().map(({ slug }) => ({ slug: slug[0] }));
}

/** Set the article title, summary, and cover for sharing. */
export async function generateMetadata(props: PageProps<"/blog/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const post = getBlogPost(slug);
  if (!post) notFound();

  return {
    title: post.data.title,
    description: post.data.description,
    openGraph: post.data.cover
      ? { images: [{ url: post.data.cover.src, alt: post.data.cover.alt }] }
      : undefined,
  };
}

/** Full article view. */
export default async function BlogPostPage(props: PageProps<"/blog/[slug]">) {
  const { slug } = await props.params;
  const post = getBlogPost(slug);
  if (!post) notFound();
  const MDX = post.data.body;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 pt-12 pb-24 sm:pt-20">
      <article>
        <header className="mx-auto max-w-3xl">
          <Link
            href={blogRoute}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-sm outline-none focus-visible:ring-2"
          >
            ← All stories
          </Link>
          <p className="text-muted-foreground mt-12 text-sm">
            <time dateTime={post.data.date}>{blogDate(post.data.date)}</time>
          </p>
          <h1 className="font-heading type-display-lg mt-4 text-balance">{post.data.title}</h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-xl leading-relaxed">
            {post.data.description}
          </p>
        </header>

        {post.data.video ? (
          <div className="border-border bg-card mt-12 aspect-video overflow-hidden rounded-2xl border sm:mt-16">
            <video
              src={post.data.video.src}
              poster={post.data.video.poster}
              controls
              playsInline
              preload="none"
              aria-label={`${post.data.title} launch video`}
              className="size-full"
            >
              <track
                kind="captions"
                src={post.data.video.captions}
                srcLang="en"
                label="English captions"
              />
              Your browser does not support video playback.
            </video>
          </div>
        ) : post.data.cover ? (
          <div className="border-border bg-card mt-12 aspect-[1200/760] overflow-hidden rounded-2xl border sm:mt-16">
            <Image
              src={post.data.cover.src}
              alt={post.data.cover.alt}
              width={1200}
              height={760}
              priority
              className="size-full object-cover"
            />
          </div>
        ) : null}

        <div className="prose dark:prose-invert prose-lg prose-headings:font-heading prose-headings:tracking-tight prose-p:text-muted-foreground prose-headings:text-foreground mx-auto mt-12 max-w-3xl sm:mt-16">
          <MDX />
        </div>
      </article>

      <div className="border-border mx-auto mt-16 max-w-3xl border-t pt-8">
        <Link href={blogRoute} className="hover:underline hover:underline-offset-4">
          ← Back to the blog
        </Link>
      </div>
    </main>
  );
}
