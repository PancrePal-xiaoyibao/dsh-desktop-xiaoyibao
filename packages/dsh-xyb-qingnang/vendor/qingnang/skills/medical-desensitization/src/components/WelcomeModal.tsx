'use client';

import { motion } from 'framer-motion';
import { useChatStore } from '@/store/useChatStore';

export default function WelcomeModal() {
  const agreeToTerms = useChatStore((state) => state.agreeToTerms);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-xl"
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="w-full max-w-md p-10 mx-4 bg-white/95 shadow-2xl rounded-[2.5rem] border border-white relative overflow-hidden"
      >
        {/* Decorative background elements */}
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-teal-100 rounded-full blur-3xl opacity-50" />
        <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-cream-200 rounded-full blur-3xl opacity-50" />

        <div className="relative z-10">
          <div className="w-16 h-16 bg-teal-50 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-sm border border-teal-100">
            <span className="text-3xl">🌸</span>
          </div>

          <h1 className="text-3xl font-bold text-stone-800 mb-4 text-center tracking-tight">
            开始使用病历脱敏工作台
          </h1>
          <p className="text-stone-500 mb-8 text-center leading-relaxed font-medium">
            这里主要用于处理 PDF 和文本病例资料。<br />
            现在也支持连续病例批量上传与 Markdown 导出。<br />
            在把内容发给 AI 前，先完成敏感信息遮挡，<br />
            再继续做分析、归档或协作。
          </p>

          <div className="bg-stone-50 p-4 rounded-2xl mb-8 border border-stone-100/50">
            <div className="text-[11px] text-stone-400 text-center uppercase tracking-[0.2em] font-bold mb-1">
              安全与隐私
            </div>
            <div className="text-xs text-stone-500 text-center italic">
              您的对话是私密的。点击开始即代表您同意{' '}
              <a
                href="https://uei55ql5ok.feishu.cn/wiki/Kwxew1trEizLxEkVbnEc27annh2?from=from_copylink"
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-600 font-bold hover:underline"
              >
                用户协议
              </a>
            </div>
          </div>

          <motion.button
            whileHover={{ scale: 1.02, backgroundColor: '#0f766e' }}
            whileTap={{ scale: 0.98 }}
            onClick={agreeToTerms}
            className="w-full py-4 bg-teal-600 text-white font-bold rounded-2xl transition-all shadow-lg shadow-teal-600/30 text-lg"
          >
            开始使用
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
