import SchedulesClient from "./client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Schedules // adherence.ml",
  description:
    "Run a saved prediction on a daily or weekly cadence and stream results into history.",
};

export default function Page() {
  return <SchedulesClient />;
}
