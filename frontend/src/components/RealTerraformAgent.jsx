// RealTerraformAgent.jsx - Complete File
import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Bot, User, Shield, Code, Terminal, CheckCircle, AlertTriangle, Info, ExternalLink, Copy, Check } from 'lucide-react';

// API URL - auto-detects localhost or uses environment variable
const API_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:3001' 
  : (import.meta.env.VITE_API_URL || '');

export default function RealTerraformAgent() {
  const [userConnection, setUserConnection] = useState(null);
  const [showOnboardingModal, setShowOnboardingModal] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [externalId, setExternalId] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [messages, setMessages] = useState([{
    role: 'assistant',
    content: '👋 Hi! I\'m your AWS Terraform Assistant.\n\n**Ask me anything about AWS:**\n• "What is Amazon S3?"\n• "Explain EC2 pricing"\n• "Best practices for VPC"\n\n**Or tell me what to create:**\n• "Create an S3 bucket"\n• "Deploy a Lambda function"\n\n💡 No login needed for questions! When you want to create resources, I\'ll guide you through a secure 2-minute AWS setup.'
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [pendingCreation, setPendingCreation] = useState(null);
  const messagesEndRef = useRef(null);

  // TODO: REPLACE WITH YOUR AWS ACCOUNT ID (get from AWS Console top-right)
  const TERRAFORM_AI_ACCOUNT_ID = '639713290923';

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const savedConnection = localStorage.getItem('aws_connection');
    if (savedConnection) {
      setUserConnection(JSON.parse(savedConnection));
    }
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const generateExternalId = () => {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  const startOnboarding = () => {
    const newExternalId = generateExternalId();
    setExternalId(newExternalId);
    setOnboardingStep(1);
    setShowOnboardingModal(true);
  };

  const getCloudFormationUrl = () => {
    // TODO: After uploading terraform-ai-role.yaml to GitHub, update this URL
    // Example: https://raw.githubusercontent.com/yourusername/terraform-ai-app/main/terraform-ai-role.yaml
    const templateUrl = encodeURIComponent(
      `https://raw.githubusercontent.com/YOUR_USERNAME/terraform-ai-app/main/terraform-ai-role.yaml`
    );
    const stackName = 'TerraformAI-Access';
    return `https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=${templateUrl}&stackName=${stackName}&param_ExternalId=${externalId}&param_TerraformAIAccountId=${TERRAFORM_AI_ACCOUNT_ID}`;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const verifyConnection = async () => {
    if (!roleArn || !externalId) {
      alert('Please enter the Role ARN from CloudFormation');
      return;
    }

    setVerifying(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/verify-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleArn, externalId })
      });

      const data = await response.json();

      if (data.valid) {
        const connection = { roleArn, externalId, accountId: data.accountId };
        setUserConnection(connection);
        localStorage.setItem('aws_connection', JSON.stringify(connection));
        setShowOnboardingModal(false);
        
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `✅ Successfully connected to AWS Account: ${data.accountId}\n\n🔒 Connection is secure using IAM Role AssumeRole.\n\nNow, what would you like me to create?`
        }]);

        if (pendingCreation) {
          processMessage(pendingCreation, connection);
          setPendingCreation(null);
        }
      } else {
        alert(`Verification failed: ${data.error}\n\nPlease check:\n1. Role ARN is correct\n2. CloudFormation stack completed successfully\n3. External ID matches`);
      }
    } catch (error) {
      alert('Failed to verify connection. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput('');
    
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);

    const lowerMessage = userMessage.toLowerCase();
    const isCreationRequest = ['create', 'deploy', 'setup', 'build', 'launch', 'make', 'provision'].some(word => lowerMessage.includes(word));

    if (isCreationRequest && !userConnection) {
      setPendingCreation(userMessage);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '🔐 To create AWS resources in YOUR account, let\'s set up a secure connection.\n\n**How it works:**\n1. You deploy a secure IAM Role in your AWS account (takes 2 minutes)\n2. This role allows me to create resources on your behalf\n3. You maintain full control and can revoke access anytime\n\n**Security:**\n✅ No credentials shared\n✅ Temporary access tokens (expire in 1 hour)\n✅ You control permissions\n✅ Full audit trail in CloudTrail\n✅ Industry standard (used by Terraform Cloud, Datadog, etc.)\n\nClick "Setup Secure Connection" below to get started.',
        needsAuth: true
      }]);
      return;
    }

    processMessage(userMessage, userConnection);
  };

  const processMessage = async (userMessage, connection) => {
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          roleArn: connection?.roleArn,
          externalId: connection?.externalId
        })
      });

      const data = await response.json();

      if (data.requiresConfirmation) {
        setPendingAction(data);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.message,
          terraformCode: data.terraformCode,
          terraformPlan: data.plan,
          resources: data.resources,
          estimatedCost: data.estimatedCost,
          warnings: data.warnings,
          requiresConfirmation: true
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.message
        }]);
      }
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '❌ Sorry, I encountered an error. Please try again.'
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (approved) => {
    if (!pendingAction) return;
    setLoading(true);
    setPendingAction(null);

    if (!approved) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '❌ Action cancelled. No resources were created. No charges incurred.\n\nFeel free to ask me to modify the plan!'
      }]);
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionId: pendingAction.actionId,
          roleArn: userConnection.roleArn,
          externalId: userConnection.externalId
        })
      });

      const data = await response.json();
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.message,
        outputs: data.outputs,
        success: data.success
      }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '❌ Failed to create resources. Please try again.'
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    setUserConnection(null);
    localStorage.removeItem('aws_connection');
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: '👋 AWS connection removed. You can still ask questions!\n\nWhen you\'re ready to create resources again, just let me know.'
    }]);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-950">
      {/* Header */}
      <div className="bg-black/30 backdrop-blur-xl border-b border-purple-500/20 px-6 py-4 shadow-lg">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              <div className="bg-gradient-to-r from-purple-500 to-pink-500 p-2 rounded-lg">
                <Terminal className="w-6 h-6 text-white" />
              </div>
              AWS Terraform AI Agent
            </h1>
            <p className="text-slate-400 text-sm mt-1 flex items-center gap-2">
              {userConnection ? (
                <>
                  <CheckCircle className="w-3 h-3 text-green-400" />
                  Connected to AWS Account: {userConnection.accountId}
                </>
              ) : (
                <>
                  <Info className="w-3 h-3 text-blue-400" />
                  Secure IAM Role authentication
                </>
              )}
            </p>
          </div>
          
          <div className="flex items-center gap-3">
            {userConnection ? (
              <button
                onClick={handleDisconnect}
                className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm transition-all flex items-center gap-2 border border-slate-700"
              >
                <Shield className="w-4 h-4" />
                Disconnect
              </button>
            ) : (
              <button
                onClick={startOnboarding}
                className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white px-4 py-2 rounded-lg text-sm transition-all flex items-center gap-2 shadow-lg"
              >
                <Shield className="w-4 h-4" />
                Setup Secure Connection
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {messages.map((msg, idx) => (
            <div key={idx}>
              <div className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0 shadow-lg">
                    <Bot className="w-6 h-6 text-white" />
                  </div>
                )}
                
                <div className={`max-w-3xl rounded-2xl px-5 py-4 shadow-lg ${
                  msg.role === 'user' 
                    ? 'bg-gradient-to-r from-blue-600 to-cyan-600 text-white' 
                    : 'bg-slate-900/80 backdrop-blur-sm text-slate-100 border border-slate-800'
                }`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                  
                  {msg.needsAuth && (
                    <button
                      onClick={startOnboarding}
                      className="mt-4 w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white rounded-lg py-3 font-medium transition-all flex items-center justify-center gap-2 shadow-lg"
                    >
                      <Shield className="w-5 h-5" />
                      Setup Secure Connection (2 min)
                    </button>
                  )}

                  {msg.terraformCode && (
                    <div className="mt-4 bg-slate-950 rounded-xl p-4 border border-slate-800">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Code className="w-4 h-4 text-purple-400" />
                          <span className="text-sm font-semibold text-purple-400">Terraform Code</span>
                        </div>
                        <button
                          onClick={() => navigator.clipboard.writeText(msg.terraformCode)}
                          className="text-xs text-slate-400 hover:text-white transition-colors"
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="text-xs text-slate-300 overflow-x-auto font-mono bg-black/50 p-3 rounded-lg">{msg.terraformCode}</pre>
                    </div>
                  )}

                  {msg.resources && msg.resources.length > 0 && (
                    <div className="mt-4 bg-blue-950/30 rounded-xl p-4 border border-blue-800/30">
                      <div className="flex items-center gap-2 mb-3">
                        <Info className="w-4 h-4 text-blue-400" />
                        <span className="text-sm font-semibold text-blue-300">Resources</span>
                      </div>
                      <ul className="text-xs text-blue-100 space-y-1">
                        {msg.resources.map((r, i) => (
                          <li key={i}>• {r}</li>
                        ))}
                      </ul>
                      {msg.estimatedCost && (
                        <p className="text-sm text-blue-300 mt-3">💰 {msg.estimatedCost}</p>
                      )}
                    </div>
                  )}
                </div>

                {msg.role === 'user' && (
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 flex items-center justify-center flex-shrink-0 shadow-lg">
                    <User className="w-6 h-6 text-white" />
                  </div>
                )}
              </div>

              {msg.requiresConfirmation && pendingAction && (
                <div className="mt-4 max-w-3xl ml-14">
                  <div className="bg-amber-950/50 backdrop-blur-sm border border-amber-800/50 rounded-xl p-5 shadow-xl">
                    <div className="flex items-start gap-3 mb-4">
                      <AlertTriangle className="w-6 h-6 text-amber-400 flex-shrink-0 mt-1" />
                      <div className="flex-1">
                        <p className="font-semibold text-amber-200 mb-2 text-lg">⚠️ Cost Warning & Confirmation</p>
                        <div className="space-y-3 text-sm">
                          <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3">
                            <p className="text-red-200 font-semibold mb-2">💰 YOU WILL BE CHARGED:</p>
                            <ul className="text-red-300 space-y-1 text-xs">
                              <li>• Resources will be created in YOUR AWS account</li>
                              <li>• AWS will bill YOU directly (not us)</li>
                              <li>• Charges start immediately after creation</li>
                              <li>• Estimated cost: <strong>{msg.estimatedCost || 'See above'}</strong></li>
                            </ul>
                          </div>
                          
                          <div className="bg-blue-900/30 border border-blue-700/50 rounded-lg p-3">
                            <p className="text-blue-200 font-semibold mb-2">ℹ️ Important Reminders:</p>
                            <ul className="text-blue-300 space-y-1 text-xs">
                              <li>• Review the Terraform plan carefully above</li>
                              <li>• Check estimated monthly costs</li>
                              <li>• Use <code className="bg-black/30 px-1 rounded">terraform destroy</code> when done</li>
                              <li>• Set up AWS Budget alerts in your account</li>
                              <li>• You can delete resources anytime in AWS Console</li>
                            </ul>
                          </div>

                          {msg.warnings && msg.warnings.length > 0 && (
                            <div className="bg-amber-900/30 border border-amber-700/50 rounded-lg p-3">
                              <p className="text-amber-200 font-semibold mb-2">⚠️ Specific Warnings:</p>
                              <ul className="text-amber-300 space-y-1 text-xs">
                                {msg.warnings.map((w, i) => (
                                  <li key={i}>• {w}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-3 mt-4">
                      <button
                        onClick={() => handleConfirm(true)}
                        disabled={loading}
                        className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 disabled:from-slate-700 disabled:to-slate-700 text-white rounded-lg py-3 px-4 font-semibold transition-all shadow-lg flex items-center justify-center gap-2"
                      >
                        <CheckCircle className="w-5 h-5" />
                        I Understand, Create Resources
                      </button>
                      <button
                        onClick={() => handleConfirm(false)}
                        disabled={loading}
                        className="flex-1 bg-slate-800 hover:bg-slate-700 text-white rounded-lg py-3 px-4 font-semibold transition-all border border-slate-700"
                      >
                        Cancel (No Charges)
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
          
          {loading && (
            <div className="flex gap-4 justify-start">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 flex items-center justify-center">
                <Bot className="w-6 h-6 text-white" />
              </div>
              <div className="bg-slate-900/80 rounded-2xl px-5 py-4 flex items-center gap-3 border border-slate-800">
                <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                <span className="text-sm text-slate-300">Processing...</span>
              </div>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="bg-black/30 backdrop-blur-xl border-t border-purple-500/20 px-6 py-4 shadow-lg">
        <div className="max-w-6xl mx-auto flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask anything or tell me what to create..."
            className="flex-1 bg-slate-900/80 text-white rounded-xl px-5 py-4 focus:outline-none focus:ring-2 focus:ring-purple-500/50 border border-slate-800 placeholder-slate-500"
            disabled={loading}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:from-slate-800 disabled:to-slate-800 text-white rounded-xl px-8 py-4 transition-all shadow-lg"
          >
            {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : <Send className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Onboarding Modal */}
      {showOnboardingModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-2xl w-full p-8 border border-slate-800 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center gap-3 mb-6">
              <Shield className="w-8 h-8 text-purple-400" />
              <div>
                <h3 className="text-2xl font-bold text-white">Setup Secure AWS Connection</h3>
                <p className="text-slate-400 text-sm mt-1">2-minute setup • Industry standard security</p>
              </div>
            </div>

            {onboardingStep === 1 && (
              <div className="space-y-6">
                <div className="bg-blue-950/30 border border-blue-800/30 rounded-xl p-5">
                  <h4 className="font-semibold text-blue-200 mb-3 flex items-center gap-2">
                    <Info className="w-5 h-5" />
                    How It Works
                  </h4>
                  <ol className="text-sm text-blue-300 space-y-2">
                    <li className="flex gap-3">
                      <span className="text-blue-400 font-bold">1.</span>
                      <span>Click button below to open AWS CloudFormation</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="text-blue-400 font-bold">2.</span>
                      <span>CloudFormation creates a secure IAM Role (30 seconds)</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="text-blue-400 font-bold">3.</span>
                      <span>Copy the Role ARN and paste it back here</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="text-blue-400 font-bold">4.</span>
                      <span>Done! Start creating infrastructure</span>
                    </li>
                  </ol>
                </div>

                <div className="bg-slate-950 rounded-xl p-4 border border-slate-800">
                  <p className="text-sm text-slate-300 mb-3">
                    <strong className="text-white">Your External ID:</strong> (used for security)
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-black/50 p-3 rounded text-xs text-purple-400 font-mono overflow-x-auto">
                      {externalId}
                    </code>
                    <button
                      onClick={() => copyToClipboard(externalId)}
                      className="p-3 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
                    >
                      {copied ? <Check className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5 text-slate-400" />}
                    </button>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => window.open(getCloudFormationUrl(), '_blank')}
                    className="flex-1 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white rounded-xl py-4 font-semibold transition-all flex items-center justify-center gap-2 shadow-lg"
                  >
                    <ExternalLink className="w-5 h-5" />
                    Open AWS CloudFormation
                  </button>
                  <button
                    onClick={() => setShowOnboardingModal(false)}
                    className="px-6 bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-4 font-semibold transition-all border border-slate-700"
                  >
                    Cancel
                  </button>
                </div>

                <button
                  onClick={() => setOnboardingStep(2)}
                  className="w-full text-center text-sm text-slate-400 hover:text-white transition-colors underline"
                >
                  Already created the role? Click here to enter ARN
                </button>
              </div>
            )}

            {onboardingStep === 2 && (
              <div className="space-y-6">
                <div className="bg-amber-950/30 border border-amber-800/30 rounded-xl p-5">
                  <p className="text-sm text-amber-200">
                    After CloudFormation completes, go to the <strong>Outputs</strong> tab and copy the <strong>RoleArn</strong> value.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Paste IAM Role ARN
                  </label>
                  <input
                    type="text"
                    value={roleArn}
                    onChange={(e) => setRoleArn(e.target.value)}
                    placeholder="arn:aws:iam::123456789012:role/TerraformAI-ExecutionRole"
                    className="w-full bg-slate-950 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-purple-500 border border-slate-800"
                  />
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={verifyConnection}
                    disabled={verifying || !roleArn}
                    className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 disabled:from-slate-700 disabled:to-slate-700 text-white rounded-xl py-4 font-semibold transition-all flex items-center justify-center gap-2 shadow-lg"
                  >
                    {verifying ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-5 h-5" />
                        Verify & Connect
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => setOnboardingStep(1)}
                    className="px-6 bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-4 font-semibold transition-all border border-slate-700"
                  >
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}