import React from 'react';


function Layout({children} : {children:React.ReactNode}) {
  return (
    <><div>This is a big header</div>
      {children}
    </>
  );
};

export default Layout;