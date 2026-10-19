'use client';

import { useChatStore } from '@/store/useChatStore';
import { Plus, MessageSquare, Trash2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

interface SidebarProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
    const {
        sessions,
        activeSessionId,
        switchSession,
        createNewSession,
        deleteSession
    } = useChatStore();

    const handleNewChat = () => {
        createNewSession();
        if (window.innerWidth < 768) {
            onClose();
        }
    };

    const handleSelectSession = (id: string) => {
        switchSession(id);
        if (window.innerWidth < 768) {
            onClose();
        }
    };

    return (
        <>
            {/* Overlay for mobile */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-stone-900/20 backdrop-blur-sm z-40 md:hidden"
                    />
                )}
            </AnimatePresence>

            <motion.aside
                initial={false}
                animate={{
                    x: isOpen ? 0 : -320,
                    opacity: isOpen ? 1 : 0
                }}
                transition={{ type: "spring", damping: 25, stiffness: 200 }}
                className={cn(
                    "fixed top-0 left-0 bottom-0 w-[280px] bg-white/90 backdrop-blur-xl border-r border-cream-200 z-50 flex flex-col shadow-2xl md:shadow-none",
                    !isOpen && "pointer-events-none md:pointer-events-auto"
                )}
            >
                <div className="p-6 flex items-center justify-between border-b border-cream-100">
                    <h2 className="text-lg font-bold text-stone-800">对话历史</h2>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-stone-100 rounded-full text-stone-400 md:hidden"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="p-4">
                    <button
                        onClick={handleNewChat}
                        className="w-full flex items-center gap-3 px-4 py-3 bg-teal-600 hover:bg-teal-700 text-white rounded-2xl transition-all shadow-lg shadow-teal-600/20 font-medium group"
                    >
                        <Plus size={20} className="group-hover:rotate-90 transition-transform duration-300" />
                        <span>开启新对话</span>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {sessions.length === 0 ? (
                        <div className="text-center py-10 text-stone-400 text-sm">
                            暂无对话记录
                        </div>
                    ) : (
                        sessions.map((session) => (
                            <div
                                key={session.id}
                                className={cn(
                                    "group relative flex items-center gap-3 px-4 py-3 rounded-2xl transition-all cursor-pointer",
                                    activeSessionId === session.id
                                        ? "bg-teal-50 text-teal-700 border border-teal-100"
                                        : "hover:bg-stone-50 text-stone-600 border border-transparent"
                                )}
                                onClick={() => handleSelectSession(session.id)}
                            >
                                <MessageSquare size={18} className={cn(
                                    activeSessionId === session.id ? "text-teal-600" : "text-stone-400"
                                )} />
                                <span className="flex-1 text-sm font-medium truncate pr-6">
                                    {session.title || '新对话'}
                                </span>

                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        deleteSession(session.id);
                                    }}
                                    className="absolute right-3 opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-50 hover:text-red-500 rounded-lg transition-all text-stone-400"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                <div className="p-6 mt-auto border-t border-cream-100">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-cream-200 flex items-center justify-center text-teal-700 font-bold text-xs shadow-inner">
                            用户
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-stone-800 truncate">脱敏工作台已开启</p>
                            <p className="text-[10px] text-stone-400 uppercase tracking-tighter">Anonymous User</p>
                        </div>
                    </div>
                </div>
            </motion.aside>
        </>
    );
}
