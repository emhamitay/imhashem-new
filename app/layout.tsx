import React from 'react';
import { Link } from "../framework/Link"

function Layout({children} : {children:React.ReactNode}) {
  return (
    <><div>This is a big header</div>
    <Link href='/'>Home</Link>
    <Link href='/login'>Login</Link>
      {children}
    </>
  );
};

export default Layout;