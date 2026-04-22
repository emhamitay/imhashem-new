import React from 'react';
import { useParams } from '../../../../framework/hooks';


const Test: React.FC = () => {
    const param = useParams<{ name: string }>();
  return (
    <>  
    This is a dynamic page. The name parameter is: {param.name}
    </>
  );
};

export default Test;