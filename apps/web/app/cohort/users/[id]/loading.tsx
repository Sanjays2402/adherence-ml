import { Skeleton } from "@/components/ui/primitives";

export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}
