import Link from "next/link";

import { Card, CardHeader, Empty } from "@/components/ui/primitives";

export default function ShareNotFound() {
  return (
    <div className="p-6">
      <Card>
        <CardHeader title="Shared result not found" hint="404" />
        <Empty
          title="This link is no longer available"
          hint="The shared prediction may have expired or the URL is malformed. Open the predictor to score a new schedule."
        />
        <div className="px-4 pb-4">
          <Link
            href="/predict"
            className="text-sm text-[var(--color-accent)] hover:underline"
          >
            Go to /predict
          </Link>
        </div>
      </Card>
    </div>
  );
}
