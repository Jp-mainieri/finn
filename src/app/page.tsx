import { FinnApp } from "@/components/FinnApp";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

export default function Home() {
  return (
    <>
      <FinnApp />
      <ServiceWorkerRegistrar />
    </>
  );
}
