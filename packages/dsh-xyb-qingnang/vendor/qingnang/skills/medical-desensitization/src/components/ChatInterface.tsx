"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useChatStore, Message } from "@/store/useChatStore";
import {
  Send,
  Mic,
  User,
  Bot,
  Menu,
  Copy,
  Check,
  Download,
  Volume2,
  MessageSquare,
  X,
  Loader2,
  Square,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { parseSSEStream } from "@/lib/sse";
import {
  startAudioCapture,
  type AudioCaptureSession,
} from "@/lib/client/audio-capture";
import { getApiURL } from "@/lib/client/api";
import { SttStreamClient } from "@/lib/client/stt-stream";
import Sidebar from "./Sidebar";

export default function ChatInterface() {
  const {
    sessions,
    activeSessionId,
    userId,
    addMessage,
    appendTokenToLastMessage,
    isLoading,
    setLoading,
  } = useChatStore();

  // 组件状态
  const [input, setInput] = useState("");
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isVoiceUIMode, setIsVoiceUIMode] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<
    "idle" | "recording" | "processing" | "speaking"
  >("idle");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState("");

  // 引用
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isSendingRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const voiceCaptureRef = useRef<AudioCaptureSession | null>(null);
  const sttStreamRef = useRef<SttStreamClient | null>(null);
  const liveTranscriptRef = useRef("");
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isVoiceModeRef = useRef(isVoiceMode);

  // 同步 isVoiceMode 到 ref，避免 useEffect 重建 recognition
  useEffect(() => {
    isVoiceModeRef.current = isVoiceMode;
  }, [isVoiceMode]);

  useEffect(() => {
    const audioPlayer = audioPlayerRef.current;

    return () => {
      if (autoSendTimerRef.current) {
        clearTimeout(autoSendTimerRef.current);
      }

      recognitionRef.current?.abort();
      sttStreamRef.current?.close();
      void voiceCaptureRef.current?.stop();
      audioPlayer?.pause();
    };
  }, []);

  // 派生数据
  const currentSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const messages = currentSession?.messages || [];
  const lastMessageContent =
    messages.length > 0 ? messages[messages.length - 1].content : "";

  // --- 浏览器原生 TTS ---
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const cleanText = text
      .replace(/[#*`_~\[\]()]/g, "")
      .replace(/\d+[.、]/g, "");
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = "zh-CN";
    utterance.rate = 1.0;
    utterance.pitch = 1.1;
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find((v) => v.lang === "zh-CN");
    if (preferredVoice) utterance.voice = preferredVoice;
    window.speechSynthesis.speak(utterance);
  }, []);

  // --- 发送聊天消息并解析流式响应 ---
  const sendChatAndStream = useCallback(
    async (userText: string, currentMessages: Message[]): Promise<string> => {
      const apiMessages = [
        ...currentMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userText },
      ];

      const response = await fetch(getApiURL("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          stream: true,
          chatId: activeSessionId,
          variables: userId ? { uid: userId } : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(`聊天服务错误: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("无法读取响应流");
      }

      return parseSSEStream(reader, appendTokenToLastMessage);
    },
    [activeSessionId, appendTokenToLastMessage, userId],
  );

  // --- 浏览器原生语音识别（仅初始化一次） ---
  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return;

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "zh-CN";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }
      if (finalTranscript) {
        setInput((prev) => prev + finalTranscript);
        if (isVoiceModeRef.current) {
          if (autoSendTimerRef.current) clearTimeout(autoSendTimerRef.current);
          autoSendTimerRef.current = setTimeout(() => handleSend(), 800);
        }
      }
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleNativeMic = async () => {
    if (!recognitionRef.current) {
      alert("您的浏览器暂不支持语音识别。");
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
    } else {
      try {
        window.speechSynthesis?.cancel();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        stream.getTracks().forEach((t) => t.stop());
        recognitionRef.current.start();
        setIsListening(true);
      } catch {
        alert("无法访问麦克风。");
      }
    }
  };

  // --- 沉浸式语音模式（API 方式） ---
  const transcribeUploadedAudio = useCallback(async (audioBlob: Blob) => {
    const formData = new FormData();
    formData.append("file", audioBlob, "recording.wav");

    const sttRes = await fetch(getApiURL("/api/stt"), {
      method: "POST",
      body: formData,
    });

    if (!sttRes.ok) {
      const errorData = await sttRes.json().catch(() => ({}));
      throw new Error(errorData.error || "语音识别失败");
    }

    const { text } = await sttRes.json();
    return typeof text === "string" ? text.trim() : "";
  }, []);

  const startRecording = async () => {
    try {
      window.speechSynthesis?.cancel();
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current.currentTime = 0;
      }

      setLiveTranscript("");
      liveTranscriptRef.current = "";

      const sttStream = new SttStreamClient();
      sttStreamRef.current = sttStream;

      void sttStream
        .start({
          language: "zh-CN",
          onTranscript: (payload) => {
            if (!payload.text) {
              return;
            }

            liveTranscriptRef.current = payload.text;
            setLiveTranscript(payload.text);
          },
        })
        .catch((error) => {
          console.warn(
            "STT WebSocket 不可用，将在停止录音后回退到上传识别:",
            error,
          );
          if (sttStreamRef.current === sttStream) {
            sttStreamRef.current = null;
          }
          sttStream.close();
        });

      voiceCaptureRef.current = await startAudioCapture({
        onChunk: (chunk) => {
          sttStream.sendChunk(chunk);
        },
      });

      setVoiceStatus("recording");
    } catch {
      sttStreamRef.current?.close();
      sttStreamRef.current = null;
      voiceCaptureRef.current = null;
      alert("麦克风启动失败。");
    }
  };

  const stopRecording = async () => {
    const captureSession = voiceCaptureRef.current;

    if (!captureSession) {
      return;
    }

    setVoiceStatus("processing");
    voiceCaptureRef.current = null;

    const sttStream = sttStreamRef.current;
    sttStreamRef.current = null;

    try {
      const { wavBlob, sampleCount } = await captureSession.stop();
      let text = liveTranscriptRef.current.trim();

      if (sttStream) {
        try {
          const streamedText = (await sttStream.stop()).trim();
          if (streamedText) {
            text = streamedText;
          }
        } catch (error) {
          console.warn("STT WebSocket 结束失败，回退到上传识别:", error);
        } finally {
          sttStream.close();
        }
      }

      if (!text) {
        if (sampleCount === 0) {
          alert("未检测到语音输入，请重试");
          setVoiceStatus("idle");
          return;
        }

        text = await transcribeUploadedAudio(wavBlob);
      }

      if (!text) {
        alert("未能识别到语音内容，请重试");
        setVoiceStatus("idle");
        return;
      }

      liveTranscriptRef.current = text;
      setLiveTranscript(text);

      // 第 2 步：发送消息并获取流式响应
      addMessage("user", text);
      addMessage("assistant", "");

      let fullText: string;
      try {
        fullText = await sendChatAndStream(text, messages);
      } catch {
        addMessage("assistant", "抱歉，病历脱敏助手暂时不可用，请稍后再试。");
        setVoiceStatus("idle");
        return;
      }

      // 第 3 步：文字转语音
      if (!fullText) {
        setVoiceStatus("idle");
        return;
      }

      const ttsRes = await fetch(getApiURL("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fullText }),
      });

      if (!ttsRes.ok) {
        console.error("TTS 错误:", await ttsRes.text());
        setVoiceStatus("idle");
        return;
      }

      const audioBlobOutput = await ttsRes.blob();
      const audioUrl = URL.createObjectURL(audioBlobOutput);
      if (audioPlayerRef.current) {
        audioPlayerRef.current.src = audioUrl;
        audioPlayerRef.current.play();
        setVoiceStatus("speaking");
        audioPlayerRef.current.onended = () => {
          setVoiceStatus("idle");
          URL.revokeObjectURL(audioUrl);
        };
      }
    } catch (err) {
      sttStream?.close();
      console.error("语音对话流程错误:", err);
      alert(
        "语音对话出错: " + (err instanceof Error ? err.message : "未知错误"),
      );
      setVoiceStatus("idle");
    }
  };

  // --- 核心发送处理 ---
  async function handleSend(overrideText?: string) {
    const userText = overrideText || input.trim();
    if (!userText || isLoading || isSendingRef.current || !activeSessionId)
      return;

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    }

    isSendingRef.current = true;
    if (!overrideText) setInput("");
    addMessage("user", userText);
    addMessage("assistant", "");
    setLoading(true);

    try {
      const fullText = await sendChatAndStream(userText, messages);

      if (isVoiceModeRef.current && fullText) {
        speak(fullText);
      }
    } catch {
      appendTokenToLastMessage("病历脱敏助手暂时不可用，请稍后再试。");
    } finally {
      setLoading(false);
      isSendingRef.current = false;
    }
  }

  // --- UI 效果 ---
  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };
  useEffect(() => {
    scrollToBottom();
  }, [messages.length, isLoading]);
  useEffect(() => {
    if (isLoading) scrollToBottom("auto");
  }, [lastMessageContent, isLoading]);

  const handleQuickReply = (text: string) => {
    if (isLoading || isSendingRef.current) return;
    handleSend(text);
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleExport = () => {
    if (!currentSession) return;
    const content = messages
      .map(
        (m) => `### ${m.role === "user" ? "用户" : "助手"}\n${m.content}\n`,
      )
      .join("\n---\n\n");
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `病历脱敏会话 - ${currentSession.title || "新对话"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseOptions = (text: string) => {
    const lines = text.split("\n");
    const options: string[] = [];
    const optionRegex = /^(\d+)[.、\s]+(.+)$/;
    lines.forEach((line) => {
      const match = line.trim().match(optionRegex);
      if (match) options.push(match[0]);
    });
    return options;
  };

  // --- 沉浸式语音 UI ---
  if (isVoiceUIMode) {
    return (
      <div className="fixed inset-0 bg-stone-900 z-50 flex flex-col items-center justify-between p-8 text-white">
        <header className="w-full flex justify-between items-center">
          <button
            onClick={() => {
              setIsVoiceUIMode(false);
              setVoiceStatus("idle");
              void stopRecording();
              window.speechSynthesis?.cancel();
            }}
            className="p-3 bg-white/10 rounded-full hover:bg-white/20 transition-colors"
          >
            <X size={24} />
          </button>
          <div className="flex flex-col items-center">
            <span className="text-teal-400 font-bold text-lg">病历脱敏助手</span>
            <span className="text-xs text-stone-500">语音分析中</span>
          </div>
          <div className="w-12 h-12" />
        </header>

        <main className="flex-1 flex flex-col items-center justify-center gap-12 text-center">
          <div className="relative">
            <AnimatePresence>
              {(voiceStatus === "recording" || voiceStatus === "speaking") && (
                <>
                  <motion.div
                    initial={{ scale: 1, opacity: 0.3 }}
                    animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.1, 0.3] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    className="absolute inset-0 bg-teal-500 rounded-full"
                  />
                  <motion.div
                    initial={{ scale: 1, opacity: 0.5 }}
                    animate={{ scale: [1, 1.8, 1], opacity: [0.5, 0, 0.5] }}
                    transition={{ repeat: Infinity, duration: 3, delay: 0.5 }}
                    className="absolute inset-0 bg-teal-400 rounded-full"
                  />
                </>
              )}
            </AnimatePresence>
            <div
              className={cn(
                "w-48 h-48 rounded-full flex items-center justify-center shadow-2xl transition-all duration-500 z-10 relative",
                voiceStatus === "recording"
                  ? "bg-teal-600 scale-110"
                  : voiceStatus === "speaking"
                    ? "bg-stone-100 text-teal-600 scale-105"
                    : "bg-stone-800 border-2 border-stone-700",
              )}
            >
              {voiceStatus === "idle" && (
                <Mic size={64} className="text-stone-400" />
              )}
              {voiceStatus === "recording" && (
                <div className="flex gap-1.5">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <motion.div
                      key={i}
                      animate={{ height: [20, 60, 20] }}
                      transition={{
                        repeat: Infinity,
                        duration: 0.6,
                        delay: i * 0.1,
                      }}
                      className="w-2 bg-white rounded-full"
                    />
                  ))}
                </div>
              )}
              {voiceStatus === "processing" && (
                <Loader2 size={64} className="animate-spin text-teal-400" />
              )}
              {voiceStatus === "speaking" && (
                <Volume2 size={64} className="animate-pulse" />
              )}
            </div>
          </div>
          <div className="space-y-4">
            <h2 className="text-2xl font-medium">
              {voiceStatus === "idle" && "准备开始语音分析了吗？"}
              {voiceStatus === "recording" && "请讲，我在听..."}
              {voiceStatus === "processing" && "正在思考..."}
              {voiceStatus === "speaking" && "正在播报分析结果..."}
            </h2>
            {liveTranscript && (
              <p className="max-w-xl text-sm leading-7 text-stone-300">
                {liveTranscript}
              </p>
            )}
          </div>
        </main>

        <footer className="w-full h-32 flex items-center justify-center">
          {voiceStatus === "idle" && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={startRecording}
              className="w-20 h-20 bg-teal-600 rounded-full flex items-center justify-center shadow-lg"
            >
              <Mic size={32} />
            </motion.button>
          )}
          {voiceStatus === "recording" && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => void stopRecording()}
              className="w-20 h-20 bg-red-500 rounded-full flex items-center justify-center"
            >
              <Square size={28} />
            </motion.button>
          )}
          {voiceStatus === "speaking" && (
            <button
              onClick={() => {
                if (audioPlayerRef.current) {
                  audioPlayerRef.current.pause();
                  setVoiceStatus("idle");
                }
              }}
              className="px-6 py-2 bg-white/10 rounded-full text-sm"
            >
              跳过播放
            </button>
          )}
          <audio ref={audioPlayerRef} className="hidden" />
        </footer>
      </div>
    );
  }

  // --- 主聊天界面 ---
  return (
    <div className="flex h-[100dvh] bg-cream-100 text-stone-800 transition-colors duration-500 overflow-hidden">
      <Sidebar isOpen={isSidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        <header className="flex-none flex items-center justify-between px-6 py-4 bg-white/70 backdrop-blur-md border-b border-cream-200 z-30 shadow-sm">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 hover:bg-stone-100 rounded-xl text-stone-500 transition-colors"
            >
              <Menu size={20} />
            </button>
            <h1 className="text-xl font-bold bg-gradient-to-r from-teal-600 to-teal-700 bg-clip-text text-transparent">
              病历脱敏助手
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setLiveTranscript("");
                liveTranscriptRef.current = "";
                setIsVoiceUIMode(true);
              }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border bg-stone-50 text-stone-500 border-stone-200"
            >
              <Volume2 size={14} />
              <span>语音对话</span>
            </button>
            <button
              onClick={() => {
                setIsVoiceMode(!isVoiceMode);
                if (!isVoiceMode) speak("语音模式已开启");
                else window.speechSynthesis.cancel();
              }}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border",
                isVoiceMode
                  ? "bg-teal-50 text-teal-700 border-teal-200"
                  : "bg-stone-50 text-stone-500 border-stone-200",
              )}
            >
              {isVoiceMode ? (
                <Volume2 size={14} />
              ) : (
                <MessageSquare size={14} />
              )}
              <span>{isVoiceMode ? "语音播报中" : "文字模式"}</span>
            </button>
            <div className="w-2 h-2 rounded-full bg-teal-500 animate-pulse" />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8 scroll-smooth">
          <div className="max-w-3xl mx-auto space-y-8">
            {messages.length === 0 && !isLoading && (
              <div className="flex flex-col items-center justify-center py-20 text-center space-y-6">
                <div className="w-20 h-20 bg-white rounded-[2.5rem] shadow-xl flex items-center justify-center text-4xl">
                  🌸
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-stone-800">
                    这里可以继续基于脱敏结果做分析
                  </h3>
                  <p className="text-stone-500 max-w-xs mx-auto text-sm leading-relaxed">
                    你可以把已经脱敏的资料继续发给助手，补充提问、生成摘要，或者整理后续沟通重点。
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-3 pt-4">
                  {["请帮我总结这份资料", "请提取重点风险", "请生成后续提问清单"].map(
                    (hint) => (
                      <button
                        key={hint}
                        onClick={() => handleQuickReply(hint)}
                        className="px-5 py-2.5 bg-white/70 hover:bg-white border border-cream-200 rounded-full text-sm text-teal-700 transition-all active:scale-95 shadow-sm hover:shadow-md"
                      >
                        {hint}
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}
            <AnimatePresence>
              {messages.map((msg, idx) => {
                const isLast = idx === messages.length - 1;
                const options =
                  isLast && msg.role === "assistant"
                    ? parseOptions(msg.content)
                    : [];

                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 20, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className={cn(
                      "flex flex-col w-full gap-3",
                      msg.role === "user" ? "items-end" : "items-start",
                    )}
                  >
                    <div
                      className={cn(
                        "flex max-w-[90%] md:max-w-[80%] gap-4",
                        msg.role === "user" ? "flex-row-reverse" : "flex-row",
                      )}
                    >
                      <motion.div
                        whileHover={{ scale: 1.1 }}
                        className={cn(
                          "flex-shrink-0 w-10 h-10 rounded-2xl flex items-center justify-center shadow-md",
                          msg.role === "user"
                            ? "bg-teal-600 text-white"
                            : "bg-white text-teal-600 border border-cream-200",
                        )}
                      >
                        {msg.role === "user" ? (
                          <User size={20} />
                        ) : (
                          <Bot size={20} />
                        )}
                      </motion.div>

                      <div
                        className={cn(
                          "relative p-5 rounded-[2rem] shadow-sm text-sm md:text-base leading-relaxed break-words group",
                          msg.role === "user"
                            ? "bg-teal-600 text-white rounded-tr-none shadow-teal-900/5"
                            : "bg-white text-stone-700 rounded-tl-none border border-cream-200 shadow-stone-200/50",
                        )}
                      >
                        {msg.role === "assistant" ? (
                          <div className="prose prose-stone prose-sm md:prose-base max-w-none prose-headings:text-teal-700 prose-a:text-teal-600">
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        )}

                        <div
                          className={cn(
                            "absolute bottom-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2",
                            msg.role === "user"
                              ? "right-full mr-2"
                              : "left-full ml-2",
                          )}
                        >
                          <button
                            onClick={() => handleCopy(msg.content, msg.id)}
                            className="p-1.5 bg-white/80 backdrop-blur-sm border border-cream-200 rounded-lg text-stone-400 hover:text-teal-600 shadow-sm transition-colors"
                            title="复制内容"
                          >
                            {copiedId === msg.id ? (
                              <Check size={14} className="text-teal-500" />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    {options.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2 ml-14 max-w-[85%]">
                        {options.map((opt) => (
                          <motion.button
                            key={opt}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            whileHover={{
                              scale: 1.02,
                              backgroundColor: "#f0fdfa",
                            }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => handleQuickReply(opt)}
                            className="px-5 py-2.5 bg-white border border-teal-100 text-teal-700 rounded-2xl text-sm font-semibold shadow-sm hover:shadow-md transition-all active:bg-teal-50"
                          >
                            {opt.includes(".")
                              ? opt.split(".")[1].trim()
                              : opt.includes("、")
                                ? opt.split("、")[1].trim()
                                : opt}
                          </motion.button>
                        ))}
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {messages.length > 0 && !isLoading && (
              <div className="flex justify-center pt-4">
                <button
                  onClick={handleExport}
                  className="flex items-center gap-2 px-6 py-2.5 bg-white border border-cream-200 rounded-2xl text-stone-500 text-sm"
                >
                  <Download size={16} />
                  导出完整对话内容
                </button>
              </div>
            )}
            {isLoading && (
              <div className="flex space-x-2 p-4">
                <Loader2 className="animate-spin text-teal-500" />
                <span>正在思考...</span>
              </div>
            )}
            <div ref={messagesEndRef} className="h-4" />
          </div>
        </main>

        <footer className="p-6 bg-cream-100/80 border-t border-cream-200">
          <div className="max-w-4xl mx-auto flex gap-3 items-end bg-white/50 p-2 rounded-[2.5rem] border shadow-lg">
            <button
              onClick={toggleNativeMic}
              className={cn(
                "p-4 rounded-full transition-colors",
                isListening
                  ? "bg-teal-600 text-white"
                  : "bg-cream-50 text-stone-400",
              )}
            >
              <Mic size={22} />
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={isListening ? "正在倾听..." : "在此输入您的心声..."}
              className="flex-1 bg-transparent border-none outline-none resize-none max-h-32 py-3 text-stone-700 text-base"
              rows={1}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || isLoading}
              className={cn(
                "p-4 rounded-full shadow-md",
                input.trim() && !isLoading
                  ? "bg-teal-600 text-white"
                  : "bg-stone-200 text-stone-400",
              )}
            >
              <Send size={22} />
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
