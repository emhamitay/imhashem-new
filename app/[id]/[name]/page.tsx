import React from 'react';
import { useParams } from '../../../framework/hooks';

const Page: React.FC = () => {
    const { id , name } = useParams<{ id: string; name: string }>();
  return (
    <>
        <h1>Dynamic Route: {name} and {id}</h1>
    </>
  );
};

export default Page;