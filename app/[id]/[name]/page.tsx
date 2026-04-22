import React from 'react';
import { getParams } from '../../../framework/context';

const Page: React.FC = () => {
    const { id , name } = getParams();
  return (
    <>
        <h1>Dynamic Route: {name} and {id}</h1>
    </>
  );
};

export default Page;