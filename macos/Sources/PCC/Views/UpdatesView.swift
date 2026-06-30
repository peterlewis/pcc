import SwiftUI

struct UpdatesView: View {
    @EnvironmentObject var serialManager: SerialManager
    // App-level instance (owned by AppDelegate): a per-visit @StateObject
    // here meant switching panes mid-install hid all progress and a return
    // visit created a fresh manager that would happily start a second
    // concurrent install against the same /Volumes/CLOCK files.
    @EnvironmentObject var updateManager: UpdateManager

    var body: some View {
        Form {
            Section {
                HStack {
                    Image(systemName: updateManager.clockMounted ? "externaldrive.fill" : "externaldrive")
                        .foregroundStyle(updateManager.clockMounted ? .green : .secondary)
                    Text(updateManager.clockMounted ? "CLOCK mounted" : "CLOCK not mounted")
                    Spacer()
                    Button("Refresh") { updateManager.refresh() }
                }

                if updateManager.clockMounted {
                    if let fwt = updateManager.installedFWT {
                        LabeledContent("Firmware (time)") {
                            Text("v\(fwt.version)  \(fwt.buildDate)")
                                .font(.caption)
                        }
                    }
                    if let fwd = updateManager.installedFWD {
                        LabeledContent("Firmware (date)") {
                            Text("v\(fwd.version)  \(fwd.buildDate)")
                                .font(.caption)
                        }
                    }
                    if let tzDate = updateManager.installedTZDate {
                        LabeledContent("Timezone data") {
                            Text(tzDate, style: .date)
                                .font(.caption)
                        }
                    }
                }
            } header: {
                Text("Installed")
            }

            Section {
                if let release = updateManager.latestRelease {
                    LabeledContent("Release") { Text(release.tag) }
                    if !release.fwtBuild.isEmpty {
                        LabeledContent("Firmware (time)") {
                            Text(release.fwtBuild).font(.caption)
                        }
                    }
                    if !release.fwdBuild.isEmpty {
                        LabeledContent("Firmware (date)") {
                            Text(release.fwdBuild).font(.caption)
                        }
                    }
                    if !release.tzVersion.isEmpty {
                        LabeledContent("Timezone data") {
                            Text(release.tzVersion).font(.caption)
                        }
                    }
                } else if updateManager.isChecking {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Checking...")
                    }
                } else {
                    Text("Not checked yet")
                        .foregroundStyle(.secondary)
                }

                Button("Check for Updates") {
                    updateManager.checkForUpdates()
                }
                .disabled(updateManager.isChecking)

                if let error = updateManager.error {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            } header: {
                Text("Latest Release")
            }

            if updateManager.latestRelease != nil && updateManager.clockMounted {
                Section {
                    if updateManager.isInstalling {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(updateManager.installProgress)
                        }
                    } else if updateManager.installProgress.hasPrefix("Done.") {
                        // "Done." prefix covers both the ejected and
                        // eject-failed variants of the completion message,
                        // so the success state still renders even when the
                        // volume unmount succeeds.
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text(updateManager.installProgress)
                        }
                    }

                    Button("Install Firmware + Timezone Data") {
                        updateManager.installUpdate(firmware: true, timezone: true)
                    }
                    .disabled(updateManager.isInstalling)

                    Button("Install Firmware Only") {
                        updateManager.installUpdate(firmware: true, timezone: false)
                    }
                    .disabled(updateManager.isInstalling)

                    Button("Install Timezone Data Only") {
                        updateManager.installUpdate(firmware: false, timezone: true)
                    }
                    .disabled(updateManager.isInstalling)

                    Text("Copying files to the clock is slow by design \u{2014} the clock prioritises display stability over USB transfer speed. When the copy finishes PCC ejects the CLOCK volume for you; reconnect the clock to apply.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Install")
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { updateManager.refresh() }
    }
}
