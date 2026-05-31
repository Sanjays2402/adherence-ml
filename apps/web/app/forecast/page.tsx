import ForecastClient from "./client";

export const metadata = {
  title: "Forecast // adherence.ml",
  description: "Projected adherence rate for the next 7 days with bootstrap confidence interval.",
};

export default function Page() {
  return <ForecastClient />;
}
