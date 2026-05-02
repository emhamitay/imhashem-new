'use client'
import React, { useState, useRef } from 'react';

const Button: React.FC = () => {
    const [clicked, setClick] = useState(false);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    function handleClick(){
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        setClick(true);

        timeoutRef.current = setTimeout(()=>{
            setClick(false);
        }, 2000);
    }

  return (
    <>
        <button onClick={handleClick}>
            New Button, Click Me!
        </button>
        { clicked && <span>Button was clicked!</span> }
    </>
  );
};

export default Button;