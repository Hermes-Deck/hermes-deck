import threading
import types
import unittest
import observer

class TakeoverTest(unittest.TestCase):
    def test_transfer_keeps_running_agent_and_other_profile(self):
        agent, old, caller = object(), object(), object()
        live = {'session_key':'stored', 'profile_home':'/profiles/alpha', 'agent':agent, 'running':True, 'transport':old, 'viewers':{old:1}}
        other = {'session_key':'stored', 'profile_home':'/profiles/beta', 'transport':old}
        server = types.SimpleNamespace(_sessions={'rpc':live,'other':other}, _sessions_lock=threading.RLock(),
            _session_resume_lock=threading.RLock(), _profile_home=lambda p:'/profiles/'+p)
        replies=[]
        observer.takeover_reply({'id':'take','params':{'session_id':'stored','profile':'alpha'}},caller,replies.append,server)
        self.assertEqual(replies[0]['result'], {'ok':True,'mode':'transferred','session_id':'rpc'})
        self.assertIs(live['agent'],agent)
        self.assertTrue(live['running'])
        self.assertIs(live['transport'],caller)
        self.assertIs(other['transport'],old)
        self.assertFalse(live['viewers'])

    def test_legacy_record_interrupts_then_closes_and_resumes(self):
        caller, replies, calls = types.SimpleNamespace(write=lambda obj: True), [], []
        live = {'session_key':'stored', 'profile_home':None, 'running':True}
        server = types.SimpleNamespace(_sessions={'rpc':live}, _sessions_lock=threading.RLock(),
            _session_resume_lock=threading.RLock(), _profile_home=lambda p:None)
        def dispatch(request, transport=None):
            calls.append(request['method'])
            if request['method'] == 'session.interrupt': live['running'] = False
            if request['method'] == 'session.close': server._sessions.clear()
            result = {'session_id':'new'} if request['method'] == 'session.resume' else {'status':'interrupted'}
            return {'jsonrpc':'2.0','id':request['id'],'result':result}
        server.dispatch = dispatch
        observer.takeover_reply({'id':'take','params':{'session_id':'stored','profile':'default'}},caller,replies.append,server)
        self.assertEqual(calls, ['session.interrupt','session.close','session.resume'])
        self.assertEqual(replies[0]['result'], {'ok':True,'mode':'restarted','session_id':'new'})

    def test_interrupt_that_has_not_stopped_the_writer_does_not_close_or_resume(self):
        from unittest.mock import patch
        live={'session_key':'stored','profile_home':None,'running':True};calls=[];replies=[]
        server=types.SimpleNamespace(_sessions={'old':live},_sessions_lock=threading.RLock(),_profile_home=lambda p:None)
        def dispatch(request,transport):
            calls.append(request['method']);return {'id':request['id'],'result':{'status':'interrupt_requested'}}
        server.dispatch=dispatch
        with patch.object(observer.time,'monotonic',side_effect=[0,0,11]):
            observer.takeover_reply({'id':'take','params':{'session_id':'stored','profile':'default'}},types.SimpleNamespace(write=lambda obj:True),replies.append,server)
        self.assertEqual(calls,['session.interrupt']);self.assertTrue(live['running']);self.assertEqual(replies[0]['error']['code'],4009)

    def test_control_socket_takeover_moves_live_events_between_two_callers(self):
        import json
        import socket
        import sys
        import tempfile
        import time
        from pathlib import Path
        from unittest.mock import patch
        from testhost import install_fake_hermes
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules):
            home = Path(tmp)
            install_fake_hermes(home)
            from tui_gateway import server
            server._profile_home = lambda profile: None
            original_agent = object()
            live = server._sessions['rpc-tui']
            live.update(session_key='stored', profile_home=None, agent=original_agent, running=True)
            instance = observer.Observer(home / 'hermes-deck/processes')
            stop = threading.Event()
            worker = threading.Thread(target=instance.start_control, args=(stop,), daemon=True)
            worker.start()
            deadline = time.monotonic()+2
            while not instance.control_socket and time.monotonic()<deadline: time.sleep(.01)
            first, second = socket.socket(socket.AF_UNIX,socket.SOCK_STREAM), socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            try:
                for index, client in enumerate((first,second)):
                    client.settimeout(2); client.connect(instance.control_socket)
                    request = {'jsonrpc':'2.0','id':str(index),'method':'deck.takeover','params':{'session_id':'stored','profile':'default'}}
                    client.sendall(json.dumps(request).encode()+b'\n')
                    with client.makefile('rb') as incoming: reply=json.loads(incoming.readline())
                    self.assertEqual(reply['result']['mode'],'transferred')
                self.assertIs(live['agent'],original_agent); self.assertTrue(live['running'])
                live['transport'].write({'jsonrpc':'2.0','method':'event','params':{'session_id':'rpc-tui','type':'message.delta','payload':{'text':'still running'}}})
                self.assertIn(b'still running',second.recv(4096))
                first.settimeout(.1)
                with self.assertRaises(socket.timeout): first.recv(4096)
            finally:
                first.close();second.close();stop.set();worker.join(2)
            self.assertFalse(worker.is_alive())

    def test_pooled_cold_resume_preserves_mode_and_does_not_submit_text(self):
        received = threading.Event(); replies=[]; calls=[]
        owner = types.SimpleNamespace(write=lambda obj: True)
        server=types.SimpleNamespace(_sessions={},_sessions_lock=threading.RLock(),_profile_home=lambda p:None)
        def dispatch(request, transport):
            calls.append(request['method'])
            threading.Timer(.01,transport.write,args=({'jsonrpc':'2.0','id':request['id'],'result':{'session_id':'cold'}},)).start()
        server.dispatch=dispatch
        def emit(reply): replies.append(reply);received.set()
        observer.takeover_reply({'id':'take','params':{'session_id':'stored','profile':'default'}},owner,emit,server)
        self.assertTrue(received.wait(1));self.assertEqual(calls,['session.resume'])
        self.assertEqual(replies[0]['result'],{'ok':True,'mode':'restarted','session_id':'cold'})

if __name__ == '__main__': unittest.main()
