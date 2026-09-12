import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold text-foreground">404</h1>
      <p className="text-muted-foreground">Page not found</p>
      <Link
        href="/workbench"
        className="text-sm text-foreground underline underline-offset-4 hover:opacity-70"
      >
        返回工作台
      </Link>
    </div>
  );
}
