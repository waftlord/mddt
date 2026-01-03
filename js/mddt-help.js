// mddt-help.js — Help / About / License (2025 Waftlord / Waft Soft)

document.addEventListener('DOMContentLoaded', function () {
  const helpContent = `
    <div style="text-align:left; line-height:1.55; max-width:820px;">

      <style>
        [data-panel-id="help"] h2,
        [data-panel-id="help"] h3 {
          text-align:left !important;
        }
      </style>

      <h2>MDDT — Machinedrum Data Tool</h2>
          <h3>V2.0</h3>

      <p>
        <strong>MDDT</strong> is an independent, browser-based librarian and data
        transfer tool for the <strong>Elektron Machinedrum SPS-1 / SPS-1UW</strong>.
        It uses WebMIDI and SysEx to back up, restore, and manage
        device data.
      </p>

      <p>
        Many classic Elektron workflows depend on legacy software. MDDT was created to give Machinedrum users an alternative that runs directly in
        the browser and works on current 64-bit systems.
      </p>

        <h3>Requirements</h3>
        <ul>
          <li>A Machinedrum.</li>
          <li>A computer running Chrome.</li>
          <li>
          A decent MIDI interface/TM-1 connected to MDs IN and OUT.
          </li>
        </ul>



      <h3>Safety & responsibility</h3>
      <ul>
        <li>MDDT communicates with your Machinedrum using MIDI / SysEx.</li>
        <li><strong>It can overwrite or erase data.</strong> Always make backups first.</li>
        <li>
          Transfers may fail if MIDI is unstable (adapters, hubs, drivers, Turbo
          settings).
        </li>
      </ul>

      <h3>License</h3>
      <p>
        Copyright © 2026 <strong>Waftlord / Waft Soft</strong>
      </p>
      <p>
        Licensed under the <strong>Apache License, Version 2.0</strong> (the
        “License”); you may not use this software except in compliance with the
        License.
      </p>
      <p>
        You may obtain a copy of the License at:<br>
        <code>http://www.apache.org/licenses/LICENSE-2.0</code>
      </p>
      <p>
        Unless required by applicable law or agreed to in writing, software
        distributed under the License is distributed on an <strong>“AS IS”</strong>
        BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
        implied. See the License for the specific language governing permissions
        and limitations under the License.
      </p>

      <p>
        <em>In plain terms:</em> you use this software at your own risk. There is
        no guarantee it will work correctly for your specific setup or preserve
        your data.
      </p>

      <h3>Support development</h3>
      <p>
        If MDDT saves you time, helps protect your work, or improves your workflow,
        consider supporting its development. Support helps cover hosting and continued development and maintenance.
      </p>

  <p>
  Contributions, bug reports, and feature suggestions are welcome —
  please open an issue or pull request at
  <a href="https://github.com/waftlord/mddt">github.com/waftlord/mddt</a>
</p>

      <h3>Contact</h3>
 <p>
   For support, bug reports, or general enquiries:<br>
   <a href="mailto:computerrhythm@gmail.com">
     computerrhythm@gmail.com
   </a>
 </p>

      <h3>Affiliation</h3>
      <p>
        This is an independent, unofficial project and is not affiliated with
        Elektron. “Elektron”, “Machinedrum”, and related names are trademarks of
        their respective owners.
      </p>


    </div>
  `;

  const helpPanel =
  document.getElementById("helpMount") ||
  document.querySelector('[data-panel-id="help"] .panel-content');
  if (helpPanel) helpPanel.innerHTML = helpContent;
});
