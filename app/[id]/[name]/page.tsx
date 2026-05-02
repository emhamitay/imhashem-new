import React from "react";
import { useParams } from "../../../framework/hooks";

const Page: React.FC = () => {
  const params = useParams<{ id: string; name: string }>();

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 600 }}>
      <h1>useParams test</h1>
      <p>
        Try changing the URL segments — e.g.{" "}
        <code>/42/alice</code>, <code>/abc/bob</code>, <code>/123/charlie</code>.
      </p>

      <h2>Destructured</h2>
      <ul>
        <li>
          <strong>id:</strong> {params.id}
        </li>
        <li>
          <strong>name:</strong> {params.name}
        </li>
      </ul>

      <h2>Raw params object</h2>
      <pre
        style={{
          background: "#f4f4f4",
          padding: "1rem",
          borderRadius: 4,
          overflow: "auto",
        }}
      >
        {JSON.stringify(params, null, 2)}
      </pre>
    </div>
  );
};

export default Page;
