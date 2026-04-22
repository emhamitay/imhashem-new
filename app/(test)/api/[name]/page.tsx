import React from 'react';
import { useParams } from "../../../../framework/hooks";
import Test from "./Test";

const Page: React.FC = () => {
  const param = useParams<{ name: string }>();

  return (
    <>
    hello {param.name}
    <div>
        <Test />
    </div>
    </>
  );
};
export default Page;