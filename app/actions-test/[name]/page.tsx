import { ActionsTester } from "../../../components/ActionsTester.tsx";

type PageProps = {
  params: { name: string };
};

export default function ActionsTestPage({ params }: PageProps) {
  return (
    <main>
      <h1>Server Actions Test Page</h1>
      <p>Route segment name: {params.name}</p>
      <ActionsTester expectedName={params.name} />
    </main>
  );
}
