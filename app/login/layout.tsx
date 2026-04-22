import React from 'react';


function layout({children} : {children:React.ReactNode}) {
  return (
    <>
    <span>Welcome to layout.layout!</span>
      {children}
    </>
  );
};

export default layout;
<span>Welcome to layout.layout!</span>