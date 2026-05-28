import { createContext, useContext } from 'react';

export const TypingContext = createContext<(v: boolean) => void>(() => {});
export const useSetTyping = () => useContext(TypingContext);
