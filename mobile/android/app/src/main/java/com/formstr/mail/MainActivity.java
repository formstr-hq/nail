package com.formstr.mail;

import android.os.Bundle;

import com.formstr.mail.notify.NotifierPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before super so the bridge exposes the Notifier plugin to JS.
        registerPlugin(NotifierPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
