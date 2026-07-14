import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, ChevronRight, ExternalLink, Search } from 'lucide-react';
import { Card, Input, cn } from '@cloudforge/ui';
import { PageHeader } from '../../components/PageHeader.js';
import {
  articleIdForHref,
  findDocumentationArticle,
  searchDocumentation,
  type DocumentationCategory,
} from './documentation-catalog.js';

const CATEGORIES: readonly DocumentationCategory[] = [
  'Start here',
  'Operate',
  'Reference',
  'Develop',
];

export function DocumentationPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const selected = findDocumentationArticle(params.get('doc'));
  const results = useMemo(() => searchDocumentation(query), [query]);
  const select = useCallback(
    (id: string): void => {
      setParams({ doc: id });
      document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [setParams],
  );
  const components = useMemo(() => markdownComponents(select), [select]);

  return (
    <>
      <PageHeader
        title="Documentation"
        description="Offline guides bundled with this CloudForge build."
      />
      <div className="grid min-h-[680px] grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="h-fit overflow-hidden lg:sticky lg:top-0">
          <div className="border-border border-b p-3">
            <div className="relative">
              <Search className="text-muted-foreground absolute left-3 top-2.5 size-4" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search all guides…"
                aria-label="Search documentation"
                className="pl-9"
              />
            </div>
          </div>
          <nav
            className="max-h-[calc(100vh-230px)] overflow-y-auto p-2"
            aria-label="Documentation articles"
          >
            {CATEGORIES.map((category) => {
              const articles = results.filter((article) => article.category === category);
              if (articles.length === 0) return null;
              return (
                <section key={category} className="mb-4">
                  <p className="text-muted-foreground px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider">
                    {category}
                  </p>
                  {articles.map((article) => (
                    <button
                      type="button"
                      key={article.id}
                      onClick={() => select(article.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                        article.id === selected.id
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                      )}
                    >
                      <BookOpen className="size-3.5 shrink-0" />
                      <span className="truncate">{article.title}</span>
                      {article.id === selected.id ? (
                        <ChevronRight className="ml-auto size-3.5" />
                      ) : null}
                    </button>
                  ))}
                </section>
              );
            })}
            {results.length === 0 ? (
              <p className="text-muted-foreground p-4 text-center text-sm">
                No guide matches “{query}”.
              </p>
            ) : null}
          </nav>
        </Card>

        <Card className="min-w-0 px-7 py-7 sm:px-10">
          <div className="border-border mb-7 border-b pb-5">
            <p className="text-primary text-xs font-semibold uppercase tracking-wide">
              {selected.category}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{selected.title}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{selected.summary}</p>
          </div>
          <article className="documentation-content max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {selected.content}
            </ReactMarkdown>
          </article>
        </Card>
      </div>
    </>
  );
}

function text(children: ReactNode): string {
  return Array.isArray(children)
    ? children.map(text).join('')
    : typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : '';
}

function slug(children: ReactNode): string {
  return text(children)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function markdownComponents(select: (id: string) => void): Components {
  return {
    h1: ({ children }) => (
      <h1
        id={slug(children)}
        className="mb-4 mt-8 scroll-mt-4 text-2xl font-semibold tracking-tight first:mt-0"
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        id={slug(children)}
        className="border-border mb-3 mt-8 scroll-mt-4 border-b pb-2 text-xl font-semibold"
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 id={slug(children)} className="mb-2 mt-6 scroll-mt-4 text-base font-semibold">
        {children}
      </h3>
    ),
    p: ({ children }) => <p className="text-foreground/90 mb-4 text-sm leading-7">{children}</p>,
    ul: ({ children }) => (
      <ul className="mb-4 ml-6 list-disc space-y-1 text-sm leading-7">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-4 ml-6 list-decimal space-y-1 text-sm leading-7">{children}</ol>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-primary/50 bg-primary/5 my-4 border-l-4 px-4 py-3 [&>p]:mb-0">
        {children}
      </blockquote>
    ),
    code: ({ className, children }) =>
      className ? (
        <code className={className}>{children}</code>
      ) : (
        <code className="bg-secondary rounded px-1.5 py-0.5 font-mono text-xs">{children}</code>
      ),
    pre: ({ children }) => (
      <pre className="mb-5 overflow-x-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-6 text-zinc-100">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="mb-5 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-border bg-secondary border px-3 py-2 font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border-border border px-3 py-2 align-top">{children}</td>,
    hr: () => <hr className="border-border my-8" />,
    a: ({ href, children }) => {
      const id = articleIdForHref(href);
      if (id)
        return (
          <button
            type="button"
            className="text-primary inline font-medium hover:underline"
            onClick={() => select(id)}
          >
            {children}
          </button>
        );
      if (href?.startsWith('#'))
        return (
          <a href={href} className="text-primary font-medium hover:underline">
            {children}
          </a>
        );
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-primary inline-flex items-center gap-1 font-medium hover:underline"
        >
          {children}
          <ExternalLink className="size-3" />
        </a>
      );
    },
  };
}
